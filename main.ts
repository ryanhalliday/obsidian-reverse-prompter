import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import OpenAI from 'openai';

interface ReversePrompterSettings {
	openAIApiKey: string;
	prompt: string;
	prefix: string;
	postfix: string;
}

const DEFAULT_PROMPT = "You are a writing assistant. " + 
"Your role is to help a user write. " +
"Infer the type of writing from the user's input and ask insightful questions to help the user write more. " +
"Your questions should be open-ended and encourage the user to think creatively. " +
"Focus your questions on helping the writer keep moving quickly through and prevent writers block. " +
"Write nothing other than one question. " + 
"Example: What is the main character's motivation?"

const DEFAULT_SETTINGS: ReversePrompterSettings = {
	openAIApiKey: '',
	prompt: DEFAULT_PROMPT,
	prefix: '> ',
	postfix: '\n',
}

export default class ReversePrompter extends Plugin {
	settings: ReversePrompterSettings;

	dividerRegex: RegExp = /^(#+)|(-{3,})/gim;

	inProgress = false;

	getContentTillLastHeading(editor: Editor, cursorPos: CodeMirror.Position): string {
		const cursorOffset = editor.posToOffset(cursorPos);

		const matches = editor.getValue().matchAll(this.dividerRegex);

		const invertedMatchIndexes = Array.from(matches, (match) => {
			if (match.index !== undefined) {
				return {
					match: match[0],
					index: match.index
				}
			}
		}).filter(m => m !== undefined).reverse();
		
		for (const match of invertedMatchIndexes) {
			if (match === undefined) continue;

			// Behind cursor only
			if (match.index > cursorOffset) continue;

			// We don't want to count the heading characters itself
			const startPos = editor.offsetToPos(match.index + match.match.length);
			const checkContent = editor.getRange(startPos, cursorPos);
			if (checkContent.trim().length > 0) {
				return editor.getRange(editor.offsetToPos(match.index), cursorPos);;
			}
		}

		return '';
	}

	getText(editor: Editor){
		if (editor.somethingSelected()){
			return editor.getSelection();
		} else {
			return this.getContentTillLastHeading(editor, editor.getCursor());
		}
	}

	async *requestReversePrompt(text: string) {
		if (this.inProgress){
			new Notice('Another request is in progress');
			return;
		}

		if (this.settings.openAIApiKey.length === 0){
			new Notice('OpenAI API Key is not set');
			return;
		}

		if (text.length < 2){
			new Notice('Text is too short');
			return;
		}

		this.inProgress = true;
		new Notice('Requesting reverse prompt...');

		const openai = new OpenAI({
			apiKey: this.settings.openAIApiKey,
			dangerouslyAllowBrowser: true
		});
		const chatStream = await openai.chat.completions.create({
			messages: [
				{ role: 'system', content: this.settings.prompt },
				{ role: 'user', content: text }
			],
			model: 'gpt-3.5-turbo',
			stream: true
		});

		for await (const chunk of chatStream) {
			let data = chunk.choices[0]?.delta?.content || ''
			yield data;
		}

		this.inProgress = false;
	}

	async generateReversePrompt(editor: Editor){
		const text = this.getText(editor);
		console.log("Sending text to OpenAI: ", text);

		const iterator = await this.requestReversePrompt(text);
		if (!iterator) return;

		// Ensure we are on an empty line
		if (editor.getLine(editor.getCursor().line) != ""){
			editor.replaceSelection('\n');
		}

		editor.replaceSelection(this.settings.prefix);

		for await (const chunk of iterator){
			console.log(chunk);
			editor.replaceSelection(chunk);
		}

		editor.replaceSelection(this.settings.postfix);
	}

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('step-forward', 'Generate Reverse Prompt', async (evt: MouseEvent) => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {
				await this.generateReversePrompt(view.editor);
			}
		});

		this.addCommand({
			id: 'reverse-prompt-command',
			name: 'Generate Reverse Prompt',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.generateReversePrompt(editor);
			}
		});

		this.addSettingTab(new ReversePrompterSettingsTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ReversePrompterSettingsTab extends PluginSettingTab {
	plugin: ReversePrompter;

	constructor(app: App, plugin: ReversePrompter) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		
		new Setting(containerEl)
			.setName('OpenAI Api Key')
			.setDesc('Enter your OpenAI API Key')
			.addText(text => text
				.setPlaceholder('Enter your OpenAI API Key')
				.setValue(this.plugin.settings.openAIApiKey)
				.onChange(async (value) => {
					this.plugin.settings.openAIApiKey = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName("Prompt")
			.setDesc("Prompt for the reverse prompt")
			.addTextArea(textArea => {
				textArea.setPlaceholder("Enter the prompt")
				textArea.setValue(this.plugin.settings.prompt)
				textArea.onChange(async (value) => {
					this.plugin.settings.prompt = value;
					await this.plugin.saveSettings();
				})
				textArea.inputEl.rows = 10;
				textArea.inputEl.style.minWidth = "300px";
				textArea.inputEl.style.width = "100%";
			});
		
		new Setting(containerEl)
			.setName('AI Response Prefix')
			.addTextArea(text => text
				.setValue(this.plugin.settings.prefix)
				.onChange(async (value) => {
					this.plugin.settings.prefix = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('AI Response Postfix')
			.addTextArea(text => text
				.setValue(this.plugin.settings.postfix)
				.onChange(async (value) => {
					this.plugin.settings.postfix = value;
					await this.plugin.saveSettings();
				}));
	}
}
