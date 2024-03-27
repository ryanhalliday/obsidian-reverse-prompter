import { App, ButtonComponent, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TextAreaComponent } from 'obsidian';
import OpenAI from 'openai';

const OpenAIModels = ["gpt-4-turbo-preview", "gpt-4", "gpt-4-32k", "gpt-3.5-turbo"] as const; 
type OpenAIModel = typeof OpenAIModels[number]; 

interface ReversePrompterSettings {
	openAIApiKey: string;
	prompt: string;
	prefix: string;
	postfix: string;
	model: OpenAIModel;
	includePath: boolean;
	regex: string;
}

const DEFAULT_PROMPT = "You are a writing assistant. Your role is to help a user write. \n" + 
"Infer the type of writing from the user's input and ask insightful and interesting questions to help the user write more. \n" +
"Your questions should be open-ended and encourage the user to think creatively. \n" +
"Focus your questions on helping the writer keep moving quickly through and prevent writers block. \n" +
"The user may provide you with the document file path. \n" +
"If you see other AI questions, ensure your questions are different. \n" +
"Write nothing other than one question. "

const DEFAULT_SETTINGS: ReversePrompterSettings = {
	openAIApiKey: '',
	prompt: DEFAULT_PROMPT,
	prefix: '> AI: ',
	postfix: '\n',
	model: 'gpt-4',
	includePath: true,
	regex: "^(#+)|(-{3,})"
}

export default class ReversePrompter extends Plugin {
	settings: ReversePrompterSettings;

	inProgress = false;

	getContentTillLastHeading(editor: Editor, cursorPos: CodeMirror.Position): string {
		const cursorOffset = editor.posToOffset(cursorPos);

		const re = new RegExp(this.settings.regex, 'gim');
		const matches = editor.getValue().matchAll(re);

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
				return editor.getRange(editor.offsetToPos(match.index), cursorPos);
			}
		}

		// no match found so go till top of doc
		return editor.getValue().substring(0, cursorOffset);
	}

	getText(view: MarkdownView, editor: Editor){
		let txt = "";

		if (this.settings.includePath){
			const title = view.file?.path;
			if (title){
				txt += `File: ${title}\n`
			}
		}

		if (editor.somethingSelected()){
			txt += editor.getSelection();
		} else {
			txt += this.getContentTillLastHeading(editor, editor.getCursor());
		}

		return txt
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
			model: this.settings.model,
			stream: true
		});

		for await (const chunk of chatStream) {
			const data = chunk.choices[0]?.delta?.content || ''
			yield data;
		}

		this.inProgress = false;
	}

	async generateReversePrompt(view: MarkdownView, editor: Editor){
		const text = this.getText(view, editor);
		console.log("Sending text to OpenAI:\n" + text);

		const iterator = await this.requestReversePrompt(text);
		if (!iterator) return;

		if (editor.somethingSelected()){
			const end = editor.listSelections().reduce((acc, selection) => {
				return Math.max(acc, Math.max(selection.anchor.line, selection.head.line));
			}, editor.getCursor().line);

			editor.setCursor(end, 0)
		}

		const currentLine = editor.getCursor().line;
		const currentLineContent = editor.getLine(currentLine);

		// Ensure we are on an empty line
		if (currentLineContent != ""){
			// Shift to the end of the line and add a new line
			editor.setCursor(currentLine, currentLineContent.length);
			editor.replaceSelection('\n');
		}

		editor.replaceSelection(this.settings.prefix);

		let response = '';
		for await (const chunk of iterator){
			editor.replaceSelection(chunk);
			response += chunk;
		}
		console.log("OpenAI Response: ", response);

		editor.replaceSelection(this.settings.postfix);
	}

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('step-forward', 'Generate Reverse Prompt', async (evt: MouseEvent) => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {
				await this.generateReversePrompt(view, view.editor);
			}
		});

		this.addCommand({
			id: 'reverse-prompt-command',
			name: 'Generate Reverse Prompt',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.generateReversePrompt(view, editor);
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

type SettingsMap = {
	[key: string]: Setting;
}

class ReversePrompterSettingsTab extends PluginSettingTab {
	plugin: ReversePrompter;
	settings: SettingsMap = {};

	constructor(app: App, plugin: ReversePrompter) {
		super(app, plugin);
		this.plugin = plugin;
		this.containerEl.id = 'reverse-prompter-settings';
	}

	configureResetButton(button: ButtonComponent, settingKey: string, completeCallback: () => void){
		button.setButtonText("Reset")
		button.onClick(async () => {
			// @ts-ignore Could fix this or move on with life.
			const defaultSettingValue = DEFAULT_SETTINGS[settingKey];

			// Update text input, does not trigger onChange
			const input: TextAreaComponent[] = this.settings[settingKey].components.filter(c => 'inputEl' in c) as TextAreaComponent[]
			if (input.length > 0){
				input[0].setValue(defaultSettingValue);
			}

			// @ts-ignore Could fix this or move on with life.
			this.plugin.settings[settingKey] = defaultSettingValue;

			await this.plugin.saveSettings();

			completeCallback();
		})
	}

	addSetting(key: string): Setting {
		const setting = new Setting(this.containerEl)
		this.settings[key] = setting;
		return setting;
	}

	display(): void {
		this.containerEl.empty();

		
		this.addSetting('openAIApiKey')
			.setName('OpenAI API key')
			.setDesc('Enter your OpenAI API key')
			.addText(text => text
				.setPlaceholder('Enter your OpenAI API key')
				.setValue(this.plugin.settings.openAIApiKey)
				.onChange(async (value) => {
					this.plugin.settings.openAIApiKey = value;
					await this.plugin.saveSettings();
				}));
		
		this.addSetting('model')
			.setName('Model')
			.setDesc('OpenAI model to use for reverse prompt generation')
			.addDropdown(dropdown => {
				OpenAIModels.forEach(model => {
					dropdown.addOption(model, model);
				});
				dropdown.setValue(this.plugin.settings.model);
				dropdown.onChange(async (value) => {
					this.plugin.settings.model = value as OpenAIModel;
					await this.plugin.saveSettings();
				});
			});

		this.addSetting('prompt')
			.setName("Prompt")
			.setDesc("Prompt for the reverse prompt")
			.addTextArea(textArea => {
				textArea.inputEl.id = "reverse-prompter-prompt";
				textArea.setPlaceholder("Enter the prompt")
				textArea.setValue(this.plugin.settings.prompt)
				textArea.onChange(async (value) => {
					this.plugin.settings.prompt = value;
					await this.plugin.saveSettings();
				})
				textArea.inputEl.rows = 10;
			})
			.addButton(button => {
				this.configureResetButton(button, 'prompt', () => {
					new Notice("Prompt reset to default");
				});
			});
		
		this.addSetting('includePath')
			.setName('Include file path')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includePath)
				.onChange(async (value) => {
					this.plugin.settings.includePath = value;
					await this.plugin.saveSettings();
				}));
		
		this.addSetting('prefix')
			.setName('AI response prefix')
			.addTextArea(text => text
				.setValue(this.plugin.settings.prefix)
				.onChange(async (value) => {
					this.plugin.settings.prefix = value;
					await this.plugin.saveSettings();
				}))
				.addButton(button => {
					this.configureResetButton(button, 'prefix', () => {
						new Notice("Prefix reset to default");
					});
				});
		
		this.addSetting('postfix')
			.setName('AI response postfix')
			.addTextArea(text => text
				.setValue(this.plugin.settings.postfix)
				.onChange(async (value) => {
					this.plugin.settings.postfix = value;
					await this.plugin.saveSettings();
				}))
				.addButton(button => {
					this.configureResetButton(button, 'postfix', () => {
						new Notice("Postfix reset to default");
					});
				});

		this.addSetting('regex')
			.setName('Divider regex')
			.addTextArea(text => {
				text.inputEl.id = "reverse-prompter-regex";
				text.setValue(this.plugin.settings.regex)
				text.onChange(async (value) => {
					this.plugin.settings.regex = value;
					await this.plugin.saveSettings();
				})
			})
			.addButton(button => {
				this.configureResetButton(button, 'regex', () => {
					new Notice("Regex reset to default");
				});
			});
	}
}
