/// <reference path="../../localtypings/monaco.d.ts" />
/// <reference path="../../built/pxteditor.d.ts" />

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as pkg from "./package";
import * as core from "./core";
import * as toolboxeditor from "./toolboxeditor"
import * as compiler from "./compiler"
import * as sui from "./sui";
import * as snippets from "./monacoSnippets"
import * as pyhelper from "./monacopyhelper";
import * as simulator from "./simulator";
import * as toolbox from "./toolbox";
import * as workspace from "./workspace";
import * as blocklyFieldView from "./blocklyFieldView";
import { ViewZoneEditorHost, ModalEditorHost, FieldEditorManager } from "./monacoFieldEditorHost";
import * as data from "./data";

import Util = pxt.Util;
import { BreakpointCollection } from "./monacoDebugger";
import { DebuggerCallStack } from "./debuggerCallStack";
import { DebuggerToolbox } from "./debuggerToolbox";
import { amendmentToInsertSnippet, listenForEditAmendments, createLineReplacementPyAmendment } from "./monacoEditAmendments";

import { MonacoFlyout } from "./monacoFlyout";
import { ErrorList } from "./errorList";
import * as auth from "./auth";

const MIN_EDITOR_FONT_SIZE = 10
const MAX_EDITOR_FONT_SIZE = 40

interface TranspileResult {
    success: boolean;
    outText?: string;
    failedResponse?: pxtc.CompileResult;
}

class CompletionProvider implements monaco.languages.CompletionItemProvider {
    constructor(public editor: Editor, public python: boolean) {
    }

    triggerCharacters?: string[] = ["(", "."];

    kindMap = {}
    private tsKindToMonacoKind(s: pxtc.SymbolKind): monaco.languages.CompletionItemKind {
        switch (s) {
            case pxtc.SymbolKind.Method: return monaco.languages.CompletionItemKind.Method;
            case pxtc.SymbolKind.Property: return monaco.languages.CompletionItemKind.Property;
            case pxtc.SymbolKind.Function: return monaco.languages.CompletionItemKind.Function;
            case pxtc.SymbolKind.Variable: return monaco.languages.CompletionItemKind.Variable;
            case pxtc.SymbolKind.Module: return monaco.languages.CompletionItemKind.Module;
            case pxtc.SymbolKind.Enum: return monaco.languages.CompletionItemKind.Class;
            case pxtc.SymbolKind.EnumMember: return monaco.languages.CompletionItemKind.Enum;
            case pxtc.SymbolKind.Class: return monaco.languages.CompletionItemKind.Class;
            case pxtc.SymbolKind.Interface: return monaco.languages.CompletionItemKind.Interface;
            default: return monaco.languages.CompletionItemKind.Text;
        }
    }

    /**
     * Provide completion items for the given position and document.
     */
    provideCompletionItems(model: monaco.editor.IReadOnlyModel, position: monaco.Position, context: monaco.languages.CompletionContext, token: monaco.CancellationToken): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
        const offset = model.getOffsetAt(position);
        const source = model.getValue();
        const fileName = this.editor.currFile.name;

        const word = model.getWordUntilPosition(position);
        const wordStartOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn })
        const wordEndOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.endColumn })

        return compiler.completionsAsync(fileName, offset, wordStartOffset, wordEndOffset, source, pxt.options.light)
            .then(completions => {
                function stripLocalNamespace(qName: string): string {
                    // leave out namespace qualifiers if we're inside a matching namespace
                    if (!qName)
                        return qName
                    for (let ns of completions.namespace) {
                        if (qName.startsWith(ns + "."))
                            qName = qName.substr((ns + ".").length)
                        else
                            break
                    }
                    return qName
                }

                let entries = completions.entries || [];
                entries = entries.filter(si => si.name.charAt(0) != "_");

                const items = entries.map((si, i) => {
                    let snippetWithMarkers = this.python ? si.pySnippetWithMarkers : si.snippetWithMarkers
                    const hasMarkers = !!snippetWithMarkers
                    const snippetWithoutMarkers = this.python ? si.pySnippet : si.snippet
                    let snippet = hasMarkers ? snippetWithMarkers : snippetWithoutMarkers;
                    snippet = stripLocalNamespace(snippet);
                    let qName = stripLocalNamespace(this.python ? si.pyQName : si.qName);
                    let name = this.python ? si.pyName : si.name;
                    let isMultiLine = snippet && snippet.indexOf("\n") >= 0

                    if (this.python && snippet && isMultiLine && pxt.blocks.hasHandler(si)) {
                        // For python, we want to replace the entire line because when creating
                        // new functions these need to be placed before the line the user was typing
                        // unlike with typescript where callbacks use lambdas.
                        //
                        // e.g. "player.on_chat"
                        // becomes:
                        //      def on_chat_handler():
                        //          pass
                        //      player.on_chat(on_chat_handler)
                        // whereas TS looks like:
                        //      player.onChat(() => {
                        //
                        //      })
                        //
                        // At the time of this writting, Monaco does not support item completions that replace the
                        // whole line. So we use a custom system of "edit amendments". See monacoEditAmendments.ts
                        // for more.
                        snippet = amendmentToInsertSnippet(
                            createLineReplacementPyAmendment(snippet))
                    } else {
                        snippet = snippet || qName
                        // if we're past the first ".", i.e. we're doing member completion, be sure to
                        // remove what precedes the "." in the full snippet.
                        // E.g. if the user is typing "mobs.", we want to complete with "spawn" (name) not "mobs.spawn" (qName)
                        if (completions.isMemberCompletion && snippet) {
                            let snippetQualifiers = getQualifiers(snippet);
                            if (qName.indexOf("anyButton") >= 0) {
                                console.log("snippet");
                                console.dir({ snippet, snippetQualifiers })
                            }
                            snippet = snippet.substr(snippetQualifiers.join('.').length + 1)
                        }
                    }
                    const label = completions.isMemberCompletion ? name : qName
                    const documentation = pxt.Util.rlf(si.attributes.jsDoc);
                    const block = pxt.Util.rlf(si.attributes.block);

                    const word = model.getWordAtPosition(position);
                    const range: monaco.IRange = {
                        startLineNumber: position.lineNumber,
                        startColumn: word ? word.startColumn : position.column,
                        endColumn: position.column,
                        endLineNumber: position.lineNumber
                    }

                    // Need to take the whitespace out of this string, otherwise monaco
                    // won't dismiss the suggest widget when the user types a space. Replace
                    // them with commas so that we don't confuse the fuzzy matcher in monaco
                    const filterText = `${label},${documentation},${block}`.replace(/\s/g, ",")

                    const kind = this.tsKindToMonacoKind(si.kind);
                    let res: monaco.languages.CompletionItem = {
                        label: label,
                        range,
                        kind,
                        documentation,
                        detail: `(${monaco.languages.CompletionItemKind[kind].toLowerCase()}) ${snippetWithoutMarkers || ""}`,
                        // force monaco to use our sorting
                        sortText: `${tosort(i)} ${snippet}`,
                        filterText: filterText,
                        insertText: snippet || undefined,
                        insertTextRules: hasMarkers ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                    };
                    return res
                })
                return { suggestions: items };
            });

        function tosort(i: number): string {
            return ("000" + i).slice(-4);
        }
        function getQualifiers(str: string): string[] {
            if (!str) return []
            const parts = str.split('.')
            parts.pop() // the last part is never a qualifier
            const isValidName = (s: string) => s.match(/^[a-zA-Z_$][0-9a-zA-Z_$]*$/)
            let quals: string[] = [];
            for (let p of parts) {
                if (!isValidName(p))
                    break;
                quals.push(p)
            }
            return quals;
        }
    }
}

class SignatureHelper implements monaco.languages.SignatureHelpProvider {
    signatureHelpTriggerCharacters: string[] = ["(", ","];

    protected isPython: boolean = false;

    constructor(public editor: Editor, public python: boolean) {
        this.isPython = python;
    }

    /**
     * Provide help for the signature at the given position and document.
     */
    provideSignatureHelp(model: monaco.editor.IReadOnlyModel, position: monaco.Position, token: monaco.CancellationToken, context: monaco.languages.SignatureHelpContext): monaco.languages.ProviderResult<monaco.languages.SignatureHelpResult> {
        const offset = model.getOffsetAt(position);
        const source = model.getValue();
        const fileName = this.editor.currFile.name;
        return compiler.syntaxInfoAsync("signature", fileName, offset, source)
            .then(r => {
                let sym = r.symbols ? r.symbols[0] : null
                if (!sym || !sym.parameters) return null;
                const documentation = pxt.Util.rlf(sym.attributes.jsDoc);
                let paramInfo: monaco.languages.ParameterInformation[] =
                    sym.parameters.map(p => ({
                        label: `${p.name}: ${this.isPython ? p.pyTypeString : p.type}`,
                        documentation: pxt.Util.rlf(p.description)
                    }))
                const res: monaco.languages.SignatureHelp = {
                    signatures: [{
                        label: `${this.isPython && sym.pyName ? sym.pyName : sym.name}(${paramInfo.map(p => p.label).join(", ")})`,
                        documentation,
                        parameters: paramInfo
                    }],
                    activeSignature: 0,
                    activeParameter: r.auxResult
                }
                return { value: res, dispose: () => { } }
            });
    }
}

class HoverProvider implements monaco.languages.HoverProvider {
    constructor(public editor: Editor, public python: boolean) {

    }

    /**
     * Provide a hover for the given position and document. Multiple hovers at the same
     * position will be merged by the editor. A hover can have a range which defaults
     * to the word range at the position when omitted.
     */
    provideHover(model: monaco.editor.IReadOnlyModel, position: monaco.Position, token: monaco.CancellationToken): monaco.languages.Hover | monaco.Thenable<monaco.languages.Hover> {
        // Don't provide hover if currently dragging snippet
        if (this.editor.hasInsertionSnippet()) return null;

        const offset = model.getOffsetAt(position);
        const source = model.getValue();
        const fileName = this.editor.currFile.name;
        return compiler.syntaxInfoAsync("symbol", fileName, offset, source)
            .then(r => {
                let sym = r.symbols ? r.symbols[0] : null

                let contents: string[];
                if (sym) {
                    const documentation = pxt.Util.rlf(sym.attributes.jsDoc);

                    contents = [r.auxResult[0], documentation];
                }
                else if (r.auxResult) {
                    contents = [r.auxResult.displayString, r.auxResult.documentation];
                }

                if (contents) {
                    const res: monaco.languages.Hover = {
                        contents: contents.map(toMarkdownString),
                        range: monaco.Range.fromPositions(model.getPositionAt(r.beginPos), model.getPositionAt(r.endPos))
                    }
                    return res;
                }
                return null;
            });
    }
}

function toMarkdownString(text: string) {
    return { value: text };
}

// reference: https://github.com/microsoft/vscode/blob/master/extensions/python/language-configuration.json
// documentation: https://code.visualstudio.com/api/language-extensions/language-configuration-guide
const pythonLanguageConfiguration: monaco.languages.LanguageConfiguration = {
    "comments": {
        "lineComment": "#",
        "blockComment": ["\"\"\"", "\"\"\""]
    },
    "brackets": [
        ["{", "}"],
        ["[", "]"],
        ["(", ")"]
    ],
    "autoClosingPairs": [
        { "open": "{", "close": "}" },
        { "open": "[", "close": "]" },
        { "open": "(", "close": ")" },
        { "open": "\"", "close": "\"", "notIn": ["string"] },
        { "open": "r\"", "close": "\"", "notIn": ["string", "comment"] },
        { "open": "R\"", "close": "\"", "notIn": ["string", "comment"] },
        { "open": "u\"", "close": "\"", "notIn": ["string", "comment"] },
        { "open": "U\"", "close": "\"", "notIn": ["string", "comment"] },
        { "open": "f\"", "close": "\"", "notIn": ["string", "comment"] },
        { "open": "F\"", "close": "\"", "notIn": ["string", "comment"] },
        { "open": "b\"", "close": "\"", "notIn": ["string", "comment"] },
        { "open": "B\"", "close": "\"", "notIn": ["string", "comment"] },
        { "open": "'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "r'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "R'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "u'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "U'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "f'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "F'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "b'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "B'", "close": "'", "notIn": ["string", "comment"] },
        { "open": "`", "close": "`", "notIn": ["string"] }
    ],
    onEnterRules: [
        {
            beforeText: /^\s*(?:def|class|for|if|elif|else|while|try|with|finally|except|async).*?:\s*$/,
            action: {
                indentAction: 1/*IndentAction.Indent*/
            }
        }
    ]
}

class FormattingProvider implements monaco.languages.DocumentRangeFormattingEditProvider {
    protected isPython: boolean = false;

    constructor(public editor: Editor, public python: boolean) {
        this.isPython = python;
    }

    provideDocumentRangeFormattingEdits(model: monaco.editor.IReadOnlyModel, range: monaco.Range, options: monaco.languages.FormattingOptions, token: monaco.CancellationToken): monaco.Thenable<monaco.editor.ISingleEditOperation[]> {
        return Promise.resolve().then(p => {
            return this.isPython
                ? pyhelper.provideDocumentRangeFormattingEdits(model, range, options, token)
                : null;
        });
    }
}

const modeMap: pxt.Map<pxt.editor.FileType> = {
    "cpp": pxt.editor.FileType.CPP,
    "h": pxt.editor.FileType.CPP,
    "json": pxt.editor.FileType.JSON,
    "md": pxt.editor.FileType.Markdown,
    "py": pxt.editor.FileType.Python,
    "ts": pxt.editor.FileType.TypeScript,
    "js": pxt.editor.FileType.JavaScript,
    "svg": pxt.editor.FileType.XML,
    "blocks": pxt.editor.FileType.XML,
    "asm": pxt.editor.FileType.Asm,
}

export class Editor extends toolboxeditor.ToolboxEditor {
    editor: monaco.editor.IStandaloneCodeEditor;
    currFile: pkg.File;
    fileType: pxt.editor.FileType = pxt.editor.FileType.Text;
    extraLibs: pxt.Map<monaco.IDisposable>;
    nsMap: pxt.Map<toolbox.BlockDefinition[]>;
    giveFocusOnLoading: boolean = true;

    protected fieldEditors: FieldEditorManager;
    protected feWidget: ViewZoneEditorHost | ModalEditorHost;
    protected foldFieldEditorRanges = true;
    protected activeRangeID: number;
    protected hasFieldEditors = !!(pxt.appTarget.appTheme.monacoFieldEditors && pxt.appTarget.appTheme.monacoFieldEditors.length);
    protected callStackView: DebuggerCallStack;
    protected breakpoints: BreakpointCollection;
    protected debuggerToolbox: DebuggerToolbox;
    protected flyout: MonacoFlyout;
    protected insertionSnippet: string;
    protected mobileKeyboardWidget: ShowKeyboardWidget;
    protected pythonSourceMap: pxtc.SourceMapHelpers;

    private loadMonacoPromise: Promise<void>;
    private diagSnapshot: string[];
    private annotationLines: number[];
    private editorViewZones: number[];
    private highlightDecorations: string[] = [];
    private highlightedBreakpoint: number;
    private editAmendmentsListener: monaco.IDisposable | undefined;
    private errorChangesListeners: pxt.Map<(errors: pxtc.KsDiagnostic[]) => void> = {};
    private exceptionChangesListeners: pxt.Map<(exception: pxsim.DebuggerBreakpointMessage, locations: pxtc.LocationInfo[]) => void> = {}
    private callLocations: pxtc.LocationInfo[];

    private userPreferencesSubscriber: data.DataSubscriber = {
        subscriptions: [],
        onDataChanged: () => {
            this.onUserPreferencesChanged();
        }
    };

    private handleFlyoutWheel = (e: WheelEvent) => e.stopPropagation();
    private handleFlyoutScroll = (e: WheelEvent) => e.stopPropagation();

    constructor(parent: pxt.editor.IProjectView) {
        super(parent);

        this.setErrorListState = this.setErrorListState.bind(this);
        this.listenToErrorChanges = this.listenToErrorChanges.bind(this);
        this.listenToExceptionChanges = this.listenToExceptionChanges.bind(this)
        this.goToError = this.goToError.bind(this);
        this.startDebugger = this.startDebugger.bind(this)
        this.onUserPreferencesChanged = this.onUserPreferencesChanged.bind(this);

        data.subscribe(this.userPreferencesSubscriber, auth.HIGHCONTRAST);
    }

    onUserPreferencesChanged() {
        const hc = data.getData<boolean>(auth.HIGHCONTRAST);

        if (this.loadMonacoPromise) this.defineEditorTheme(hc, true);
    }

    hasBlocks() {
        if (!this.currFile) return true
        let blockFile = this.currFile.getVirtualFileName(pxt.BLOCKS_PROJECT_NAME);
        return (blockFile && pkg.mainEditorPkg().files[blockFile] != null)
    }

    public openBlocks() {
        pxt.tickEvent(`typescript.showBlocks`);
        let initPromise = Promise.resolve();

        const isWinApp = pxt.BrowserUtils.isWinRT();
        if (isWinApp) {
            return;
        }

        if (!this.currFile) {
            const mainPkg = pkg.mainEditorPkg();
            if (mainPkg && mainPkg.files["main.ts"]) {
                initPromise = this.loadFileAsync(mainPkg.files["main.ts"]);
            }
            else {
                return;
            }
        }

        let promise = initPromise.then(() => {
            const isPython = this.fileType == pxt.editor.FileType.Python;
            const tickLang = isPython ? "python" : "typescript";
            pxt.tickEvent(`${tickLang}.convertBlocks`);

            const mainPkg = pkg.mainEditorPkg();
            if (!this.hasBlocks() && !mainPkg && !mainPkg.files["main.blocks"]) {
                pxt.debug(`cancelling convertion to blocks, but main.blocks is missing`);
                return undefined;
            }

            if (this.feWidget) {
                this.feWidget.close();
                this.activeRangeID = null;
            }

            let blockFile = this.currFile.getVirtualFileName(pxt.BLOCKS_PROJECT_NAME);
            let tsFile = isPython
                ? this.currFile.getVirtualFileName(pxt.JAVASCRIPT_PROJECT_NAME)
                : this.currFile.name;
            if (!this.hasBlocks()) {
                if (!mainPkg || !mainPkg.files["main.blocks"]) {
                    // Either the project isn't loaded, or it's ts-only
                    if (mainPkg) {
                        this.parent.setFile(mainPkg.files["main.ts"]);
                    }
                    return undefined;
                }

                // The current file doesn't have an associated blocks file, so switch
                // to main.ts instead
                this.currFile = mainPkg.files["main.ts"];
                blockFile = this.currFile.getVirtualFileName(pxt.BLOCKS_PROJECT_NAME);
                tsFile = "main.ts";
            }

            const failedAsync = (file: string, programTooLarge = false) => {
                core.cancelAsyncLoading("switchtoblocks");
                this.forceDiagnosticsUpdate();
                return this.showBlockConversionFailedDialog(file, programTooLarge);
            }

            // might be undefined
            let xml: string;

            // it's a bit for a wild round trip:
            // 1) convert blocks to js to see if any changes happened, otherwise, just reload blocks
            // 2) decompile js -> blocks then take the decompiled blocks -> js
            // 3) check that decompiled js == current js % white space
            let blocksInfo: pxtc.BlocksInfo;
            return this.parent.saveFileAsync()
                .then(() => this.parent.saveFileAsync())
                .then(() => this.parent.loadBlocklyAsync())
                .then(() => this.saveToTypeScriptAsync()) // make sure python gets converted
                .then(() => compiler.getBlocksAsync())
                .then((bi: pxtc.BlocksInfo) => {
                    blocksInfo = bi;
                    pxt.blocks.initializeAndInject(blocksInfo);
                    const oldWorkspace = pxt.blocks.loadWorkspaceXml(mainPkg.files[blockFile].content);
                    if (oldWorkspace) {
                        return pxt.blocks.compileAsync(oldWorkspace, blocksInfo).then((compilationResult) => {
                            const oldJs = compilationResult.source;
                            return compiler.formatAsync(oldJs, 0).then((oldFormatted: any) => {
                                return compiler.formatAsync(this.editor.getValue(), 0).then((newFormatted: any) => {
                                    if (oldFormatted.formatted == newFormatted.formatted) {
                                        pxt.debug(`${tickLang} not changed, skipping decompile`);
                                        pxt.tickEvent(`${tickLang}.noChanges`)
                                        this.parent.setFile(mainPkg.files[blockFile]);
                                        return [oldWorkspace, false]; // return false to indicate we don't want to decompile
                                    } else {
                                        return [oldWorkspace, true];
                                    }
                                });
                            });
                        })
                    }
                    return [oldWorkspace, true];
                }).then((values) => {
                    if (!values) return Promise.resolve();
                    const oldWorkspace = values[0] as Blockly.Workspace;
                    const shouldDecompile = values[1] as boolean;
                    if (!shouldDecompile) return Promise.resolve();
                    return compiler.compileAsync()
                        .then(resp => {
                            if (resp.success) {
                                return this.transpileToBlocksInternalAsync(this.currFile, blocksInfo, oldWorkspace)
                                    .then(resp => {
                                        if (!resp.success) {
                                            const failed = resp.failedResponse;
                                            this.currFile.diagnostics = failed.diagnostics;
                                            let tooLarge = false;
                                            failed.diagnostics.forEach(d => tooLarge = (tooLarge || d.code === 9266 /* error code when script is too large */));
                                            return failedAsync(blockFile, tooLarge);
                                        }
                                        xml = resp.outText;
                                        Util.assert(!!xml);
                                        return mainPkg.setContentAsync(blockFile, xml)
                                            .then(() => this.parent.setFile(mainPkg.files[blockFile]));
                                    })
                            }
                            else {
                                return failedAsync(blockFile, false)
                            }

                        })
                }).catch(e => {
                    pxt.reportException(e);
                    core.errorNotification(lf("Oops, something went wrong trying to convert your code."));
                });
        });

        core.showLoadingAsync("switchtoblocks", lf("switching to blocks..."), promise);
    }

    public showBlockConversionFailedDialog(blockFile: string, programTooLarge: boolean): Promise<void> {
        const isPython = this.fileType == pxt.editor.FileType.Python;
        const tickLang = isPython ? "python" : "typescript";

        let bf = pkg.mainEditorPkg().files[blockFile];
        if (programTooLarge) {
            pxt.tickEvent(`${tickLang}.programTooLarge`);
        }
        let body: string;
        let disagreeLbl: string;
        if (isPython) {
            body = programTooLarge ?
                lf("Your program is too large to convert into blocks. You can keep working in Python or discard your changes and go back to the previous Blocks version.") :
                lf("We are unable to convert your Python code back to blocks. You can keep working in Python or discard your changes and go back to the previous Blocks version.");
            disagreeLbl = lf("Stay in Python");
        } else {
            body = programTooLarge ?
                lf("Your program is too large to convert into blocks. You can keep working in JavaScript or discard your changes and go back to the previous Blocks version.") :
                lf("We are unable to convert your JavaScript code back to blocks. You can keep working in JavaScript or discard your changes and go back to the previous Blocks version.");
            disagreeLbl = lf("Stay in JavaScript");
        }
        return core.confirmAsync({
            header: programTooLarge ? lf("Program too large") : lf("Oops, there is a problem converting your code."),
            body,
            agreeLbl: lf("Discard and go to Blocks"),
            agreeClass: "cancel",
            agreeIcon: "cancel",
            disagreeLbl: disagreeLbl,
            disagreeClass: "positive",
            disagreeIcon: "checkmark",
            hideCancel: !bf
        }).then(b => {
            // discard
            if (!b) {
                pxt.tickEvent(`${tickLang}.keepText`, undefined, { interactiveConsent: true });
            } else {
                pxt.tickEvent(`${tickLang}.discardText`, undefined, { interactiveConsent: true });
                this.parent.saveBlocksToTypeScriptAsync().then((src) => {
                    this.overrideFile(src);
                    this.parent.setFile(bf);
                })
            }
        })
    }

    protected transpileToBlocksInternalAsync(file: pkg.File, blocksInfo: pxtc.BlocksInfo, oldWorkspace: Blockly.Workspace): Promise<TranspileResult> {
        const mainPkg = pkg.mainEditorPkg();

        const tsFilename = file.getVirtualFileName(pxt.JAVASCRIPT_PROJECT_NAME);
        const blocksFilename = file.getVirtualFileName(pxt.BLOCKS_PROJECT_NAME);

        const isPython = file.getExtension() === "py";
        const fromLanguage: pxtc.CodeLang = isPython ? "py" : "ts";
        const fromText = file.content;

        const cached = mainPkg.getCachedTranspile(fromLanguage, fromText, "blocks");

        if (cached != null) {
            return Promise.resolve({
                success: true,
                outText: cached
            });
        }

        return compiler.decompileAsync(tsFilename, blocksInfo, oldWorkspace, blocksFilename)
            .then(resp => {
                if (!resp.success) {
                    return {
                        success: false,
                        failedResponse: resp
                    };
                }

                const outText = resp.outfiles[blocksFilename];

                mainPkg.cacheTranspile(fromLanguage, fromText, "blocks", outText);
                return {
                    success: true,
                    outText
                }
            });
    }

    public decompileAsync(blockFile: string): Promise<pxtc.CompileResult> {
        return compiler.decompileAsync(blockFile)
    }

    setVisible(v: boolean) {
        super.setVisible(v);
        // if we are hiding monaco, clear error list
        if (!v) this.onErrorChanges([]);
    }

    display(): JSX.Element {
        const showErrorList = pxt.appTarget.appTheme.errorList;
        const isAndroid = pxt.BrowserUtils.isAndroid();
        const isWinApp = pxt.BrowserUtils.isWinRT();
        const textElements = isWinApp ? this.getWinAppErrorMsg(): [];

        return (
            <div id="monacoEditorArea" className={`monacoEditorArea ${isAndroid ? "android" : ""}`} style={{ direction: 'ltr' }}>
                {this.isVisible && <div className={`monacoToolboxDiv ${(this.toolbox && !this.toolbox.state.visible && !this.isDebugging()) ? 'invisible' : ''}`}>
                    <toolbox.Toolbox ref={this.handleToolboxRef} editorname="monaco" parent={this} />
                    <div id="monacoDebuggerToolbox"></div>
                </div>}

                { isWinApp ?
                    <div id="winAppError">
                        <img className="ui medium centered image" alt={lf("An image of a shrugging board")} src={pxt.appTarget.appTheme.winAppDeprImage}/>
                        <div className="ui centered" id="winAppErrorMsg">
                            {textElements}
                        </div>
                    </div>:
                    <div id="monacoEditorRightArea" className="monacoEditorRightArea">
                        <div id='monacoEditorInner'>
                            <MonacoFlyout ref={this.handleFlyoutRef} fileType={this.fileType}
                                blockIdMap={this.blockIdMap}
                                moveFocusToParent={this.moveFocusToToolbox}
                                insertSnippet={this.insertSnippet}
                                setInsertionSnippet={this.setInsertionSnippet}
                                parent={this.parent} />
                        </div>
                        {showErrorList && <ErrorList isInBlocksEditor={false} onSizeChange={this.setErrorListState}
                            listenToErrorChanges={this.listenToErrorChanges}
                            listenToExceptionChanges={this.listenToExceptionChanges} goToError={this.goToError}
                            startDebugger={this.startDebugger} />}
                    </div>
                }
            </div>
        )
    }

    getWinAppErrorMsg(): (JSX.Element | string)[] {
        const errMsg = lf("Oops! Text editing is only available on the website at {0}. Go {1} for more information.", `https://${pxt.appTarget.name}`, "{1}");
        const parts = errMsg.split(/\{\d\}/);
        const textElements: (JSX.Element | string)[] = [
            parts[0],
            <a href={"/windows-app"} target="_blank" rel="noopener noreferrer">
                {lf("here")}
            </a>,
            parts[1]]
        return textElements;
    }

    listenToExceptionChanges(handlerKey: string, handler: (exception: pxsim.DebuggerBreakpointMessage, locations: pxtc.LocationInfo[]) => void) {
        this.exceptionChangesListeners[handlerKey] = handler;
    }

    public onExceptionDetected(exception: pxsim.DebuggerBreakpointMessage) {
        for (let listener of pxt.U.values(this.exceptionChangesListeners)) {
            listener(exception, this.callLocations);
        }
    }

    listenToErrorChanges(handlerKey: string, handler: (errors: pxtc.KsDiagnostic[]) => void) {
        this.errorChangesListeners[handlerKey] = handler;
    }

    goToError(error: pxtc.LocationInfo) {
        // Use endLine and endColumn to position the cursor
        // when errors do have them
        let line, column;
        if (error.endLine && error.endColumn) {
            line = error.endLine + 1;
            column = error.endColumn + 1;
        } else {
            line = error.line + 1;
            column = error.column + error.length + 1;
        }

        this.editor.revealLineInCenter(line);
        this.editor.setPosition({ column: column, lineNumber: line });
        this.editor.focus();
    }

    startDebugger() {
        pxt.tickEvent('errorList.startDebugger', null, { interactiveConsent: true })
        this.parent.toggleDebugging()
    }

    private onErrorChanges(errors: pxtc.KsDiagnostic[]) {
        for (let listener of pxt.U.values(this.errorChangesListeners)) {
            listener(errors);
        }
    }

    public showPackageDialog() {
        pxt.tickEvent("monaco.addpackage", undefined, { interactiveConsent: true });
        this.hideFlyout();
        this.parent.showPackageDialog();
    }

    private defineEditorTheme(hc?: boolean, withNamespaces?: boolean) {
        const inverted = pxt.appTarget.appTheme.invertedMonaco;
        const invertedColorluminosityMultipler = 0.6;
        let rules: monaco.editor.ITokenThemeRule[] = [];
        if (!hc && withNamespaces) {
            const colors: pxt.Map<string> = {};
            this.getNamespaces().forEach((ns) => {
                const metaData = this.getNamespaceAttrs(ns);
                const blocks = snippets.isBuiltin(ns) ?
                    snippets.getBuiltinCategory(ns).blocks.concat(this.nsMap[ns] || []) : this.nsMap[ns];

                if (metaData.color && blocks) {
                    let hexcolor = fixColor(metaData.color);
                    blocks.forEach((fn) => {
                        rules.push({ token: `identifier.ts ${fn.name}`, foreground: hexcolor });
                    });
                    rules.push({ token: `identifier.ts ${ns}`, foreground: hexcolor });
                    colors[ns] = metaData.color;
                }
            })

            rules.push({ token: `identifier.ts if`, foreground: '5B80A5', });
            rules.push({ token: `identifier.ts else`, foreground: '5B80A5', });
            rules.push({ token: `identifier.ts while`, foreground: '5BA55B', });
            rules.push({ token: `identifier.ts for`, foreground: '5BA55B', });

            const pauseUntil = pxt.appTarget.runtime && pxt.appTarget.runtime.pauseUntilBlock;
            if (pauseUntil) {
                const call = pauseUntil.callName || "pauseUntil";
                const color = pauseUntil.color || colors[pauseUntil.category];

                if (color) {
                    rules.push({ token: `identifier.ts ${call}`, foreground: fixColor(color) });
                }
            }
        }

        const colors = pxt.appTarget.appTheme.monacoColors || {};
        monaco.editor.defineTheme('pxtTheme', {
            base: hc ? 'hc-black' : (inverted ? 'vs-dark' : 'vs'), // can also be vs-dark or hc-black
            inherit: true, // can also be false to completely replace the builtin rules
            rules: rules,
            colors: hc ? {} : colors
        });
        monaco.editor.setTheme('pxtTheme');

        function fixColor(hexcolor: string) {
            hexcolor = pxt.toolbox.convertColor(hexcolor);
            return (inverted ? pxt.toolbox.fadeColor(hexcolor, invertedColorluminosityMultipler, true) : hexcolor).replace('#', '');
        }
    }

    saveToTypeScriptAsync() {
        if (this.fileType == pxt.editor.FileType.Python)
            return this.convertPythonToTypeScriptAsync(this.isDebugging() || this.parent.state.tracing);
        return Promise.resolve(undefined)
    }

    convertPythonToTypeScriptAsync(force = false): Promise<string> {
        if (!this.currFile) return Promise.resolve(undefined);
        const tsName = this.currFile.getVirtualFileName(pxt.JAVASCRIPT_PROJECT_NAME)
        return compiler.py2tsAsync(force)
            .then(res => {
                if (res.sourceMap) {
                    const mainPkg = pkg.mainEditorPkg();
                    const tsFile = res.outfiles[tsName];
                    const pyFile = mainPkg.files[this.currFile.getFileNameWithExtension("py")]?.content;
                    if (tsFile && pyFile) {
                        this.pythonSourceMap = pxtc.BuildSourceMapHelpers(res.sourceMap, tsFile, pyFile);
                    }
                    else this.pythonSourceMap = null;
                }
                // TODO python use success
                // any errors?
                if (res.diagnostics && res.diagnostics.length)
                    return undefined;
                if (res.outfiles[tsName]) {
                    return res.outfiles[tsName]
                }
                return ""
            })
    }

    setHighContrast(hc: boolean) {
        // handled by onUserPreferencesChanged
    }

    beforeCompile() {
        // this triggers a text change wich stops the simulator async
        //if (this.editor)
        //    this.editor.getAction('editor.action.formatDocument').run();
    }

    isIncomplete() {
        if (this.editor && (this.editor as any)._view &&
            (this.editor as any)._view.contentWidgets._widgets["editor.widget.suggestWidget"].isVisible)
            return true;

        // broken pxt.json, don't save
        if (this.editor &&
            this.currFile.name === pxt.CONFIG_NAME
            && !Util.jsonTryParse(this.getCurrentSource()))
            return true;

        return false;
    }

    resize(e?: Event) {
        let monacoArea = document.getElementById('monacoEditorArea');
        if (!monacoArea) return;
        let monacoToolboxDiv = monacoArea.getElementsByClassName('monacoToolboxDiv')[0] as HTMLElement;

        if (monacoArea && this.editor) {
            const toolboxWidth = monacoToolboxDiv && monacoToolboxDiv.offsetWidth || 0;

            const logoHeight = (this.parent.isJavaScriptActive()) ? this.parent.updateEditorLogo(toolboxWidth, this.getEditorColor()) : 0;

            this.editor.layout({ width: monacoArea.offsetWidth - toolboxWidth, height: monacoArea.offsetHeight - logoHeight });

            blocklyFieldView.setEditorBounds({
                top: 0,
                left: 0,
                width: window.innerWidth,
                height: window.innerHeight
            });

            if (monacoToolboxDiv) monacoToolboxDiv.style.height = `100%`;
        }
    }

    setErrorListState(newState?: pxt.editor.ErrorListState) {
        const oldState = this.parent.state.errorListState;

        if (oldState != newState) {
            this.resize();
            this.parent.setState({
                errorListState: newState
            });
        }
    }

    prepare() {
        this.isReady = true
    }

    public loadMonacoAsync(): Promise<void> {
        if (!this.loadMonacoPromise)
            this.loadMonacoPromise = this.createLoadMonacoPromise();
        return this.loadMonacoPromise;
    }

    private createLoadMonacoPromise(): Promise<void> {
        this.extraLibs = Object.create(null);
        let editorArea = document.getElementById("monacoEditorArea");
        let editorElement = document.getElementById("monacoEditorInner");

        return pxt.vs.initMonacoAsync(editorElement).then((editor) => {
            this.editor = editor;

            // This is used to detect ios 13 on iPad, which is not properly detected by monaco
            if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !this.mobileKeyboardWidget) {
                this.mobileKeyboardWidget = new ShowKeyboardWidget(this.editor);
            }

            this.editor.updateOptions({ fontSize: this.parent.settings.editorFontSize });

            this.editor.addAction({
                id: "save",
                label: lf("Save"),
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KEY_S],
                keybindingContext: "!editorReadonly",
                precondition: "!editorReadonly",
                contextMenuGroupId: "0_pxtnavigation",
                contextMenuOrder: 0.2,
                run: () => Promise.resolve(this.parent.typecheckNow())
            });

            this.editor.addAction({
                id: "runSimulator",
                label: lf("Run Simulator"),
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
                keybindingContext: "!editorReadonly",
                precondition: "!editorReadonly",
                contextMenuGroupId: "0_pxtnavigation",
                contextMenuOrder: 0.21,
                run: () => Promise.resolve(this.parent.runSimulator())
            });

            if (pxt.appTarget.compile && pxt.appTarget.compile.hasHex) {
                this.editor.addAction({
                    id: "compileHex",
                    label: lf("Download"),
                    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Enter],
                    keybindingContext: "!editorReadonly",
                    precondition: "!editorReadonly",
                    contextMenuGroupId: "0_pxtnavigation",
                    contextMenuOrder: 0.22,
                    run: () => Promise.resolve(this.parent.compile())
                });
            }

            this.editor.addAction({
                id: "zoomIn",
                label: lf("Zoom In"),
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.NUMPAD_ADD, monaco.KeyMod.CtrlCmd | monaco.KeyCode.US_EQUAL],
                run: () => Promise.resolve(this.zoomIn())
            });

            this.editor.addAction({
                id: "zoomOut",
                label: lf("Zoom Out"),
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.NUMPAD_SUBTRACT, monaco.KeyMod.CtrlCmd | monaco.KeyCode.US_MINUS],
                run: () => Promise.resolve(this.zoomOut())
            });

            if (pxt.appTarget.appTheme.hasReferenceDocs) {
                let referenceContextKey = this.editor.createContextKey("editorHasReference", false)
                this.editor.addAction({
                    id: "reference",
                    label: lf("Help"),
                    keybindingContext: "!editorReadonly && editorHasReference",
                    precondition: "!editorReadonly && editorHasReference",
                    contextMenuGroupId: "navigation",
                    contextMenuOrder: 0.1,
                    run: () => Promise.resolve(this.loadReference())
                });

                this.editor.onDidChangeCursorPosition((e: monaco.editor.ICursorPositionChangedEvent) => {
                    let word = this.editor.getModel().getWordUntilPosition(e.position);
                    if (word && word.word != "") {
                        referenceContextKey.set(true);
                    } else {
                        referenceContextKey.reset()
                    }
                })
            }

            // Accessibility shortcut, add a way to quickly jump to the monaco toolbox
            this.editor.addAction({
                id: "jumptoolbox",
                label: lf("Jump to Toolbox"),
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KEY_T],
                keybindingContext: "!editorReadonly",
                precondition: "!editorReadonly",
                run: () => Promise.resolve(this.moveFocusToToolbox())
            });

            this.editor.onDidLayoutChange((e: monaco.editor.EditorLayoutInfo) => {
                // Update editor font size in settings after a ctrl+scroll zoom
                let currentFont = this.getEditorFontSize();
                if (this.parent.settings.editorFontSize != currentFont) {
                    this.parent.settings.editorFontSize = currentFont;
                    this.forceDiagnosticsUpdate();
                }
                // Update widgets
                const toolbox = document.getElementById('monacoToolboxDiv');
                if (toolbox) toolbox.style.height = `${this.editor.getLayoutInfo().height}px`;
            })

            const monacoEditorInner = document.getElementById('monacoEditorInner');
            if (pxt.BrowserUtils.hasPointerEvents()) {
                monacoEditorInner.onpointermove = this.onPointerMove;
                monacoEditorInner.onpointerup = this.onPointerUp;
            } else {
                monacoEditorInner.onmousemove = this.onPointerMove;
                monacoEditorInner.onmouseup = this.onPointerUp;
                if (pxt.BrowserUtils.isTouchEnabled()) {
                    // For devices without PointerEvents (iOS < 13.0), use state to
                    // hide the flyout rather than focusing the editor (onPointerMove)
                    monacoEditorInner.ontouchend = this.onPointerUp;
                }
            }

            this.editor.onDidFocusEditorText(() => {
                this.hideFlyout();
            })

            monaco.languages.registerCompletionItemProvider("python", new CompletionProvider(this, true));
            monaco.languages.registerSignatureHelpProvider("python", new SignatureHelper(this, true));
            monaco.languages.registerHoverProvider("python", new HoverProvider(this, true));
            monaco.languages.registerDocumentRangeFormattingEditProvider("python", new FormattingProvider(this, true));
            monaco.languages.setLanguageConfiguration("python", pythonLanguageConfiguration)

            this.editorViewZones = [];

            this.setupFieldEditors();
            this.editor.onMouseDown((e: monaco.editor.IEditorMouseEvent) => {
                if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                    return;
                }
                this.handleGutterClick(e);
            });

            editor.onDidChangeModelContent(e => {
                // Clear ranges because the model changed
                if (this.fieldEditors)
                    this.fieldEditors.clearRanges(editor);
            })
        })
    }

    private insertSnippet = (cursorPos: monaco.Position, insertText: string, inline = false) => {
        let currPos = this.editor.getPosition();
        let model = this.editor.getModel();
        if (!cursorPos) // IE11 fails to locate the mouse
            cursorPos = currPos;
        if (!cursorPos) {
            return
        }
        let position = cursorPos.clone()

        // determine insert mode
        type InsertMode = "NewLineBefore" | "NewLineAfter" | "Inline"
        let insertMode: InsertMode;
        if (inline)
            insertMode = "Inline"
        else if (cursorPos.column === 1)
            insertMode = "NewLineBefore"
        else
            insertMode = "NewLineAfter"

        // determine snippet insert column
        if (insertMode === "NewLineAfter") {
            // place snippet as if the cursor where at the end of the line
            position = position.with(position.lineNumber, model.getLineMaxColumn(cursorPos.lineNumber))
        } // else no change

        // if not inline, put snippet on a new line
        const cursorLineContent = model.getLineContent(cursorPos.lineNumber)
        const cursorLineIsEmpty = !cursorLineContent
        if (insertMode === "Inline") {
        } else {
            if (!cursorLineIsEmpty) {
                if (insertMode === "NewLineAfter")
                    insertText = "\n" + insertText;
                else
                    insertText = insertText + "\n";
            }
        }

        // find the correct intent
        //     Case 1:
        //     A: <-
        //         B
        //     Case 2:
        //     A:
        //         B <-
        //         C
        //     Case 3:
        //     A:
        //         B <-
        //     C
        //     Case 4:
        //     A:
        //         B: <-
        //             C
        //     Case 5:
        //         B
        //     ->C          (cursor at start of line)
        //     Case 1 => indent to B
        //     Case 2 => indent to B
        //     Case 3 => indent to B
        //     Case 4 => same as Case 1
        //     Case 5 => indent to C, insert BEFORE C
        const NUM_SPACES_PER_INDENT = 4 // 4 spaces or 1 tab = 1 indent in MakeCode TS and PY
        const getIndentLvl = (s: string) => {
            let ws = s.match(/^\s*/)[0] || ""
            ws = ws.replace("\t", " ".repeat(NUM_SPACES_PER_INDENT))
            const indentLvl = Math.floor(ws.length / NUM_SPACES_PER_INDENT) // zero-index
            return indentLvl
        }
        const cursorIndent = getIndentLvl(cursorLineContent)
        let resultIndent;
        if (insertMode === "NewLineAfter") {
            const lineAfter = Math.min(cursorPos.lineNumber + 1, model.getLineCount())
            const lineAfterIndent = getIndentLvl(model.getLineContent(lineAfter))
            resultIndent = Math.max(cursorIndent, lineAfterIndent)
        }
        else if (insertMode === "NewLineBefore")
            resultIndent = cursorIndent
        else // inline
            resultIndent = 0
        const prefix = " ".repeat(NUM_SPACES_PER_INDENT * resultIndent)
        if (prefix) {
            let insertLines = insertText.split("\n")
            insertLines = insertLines.map(l => l ? prefix + l : l)
            insertText = insertLines.join("\n")
        }

        // update cursor
        this.editor.pushUndoStop();
        this.editor.executeEdits("", [
            {
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                text: insertText || "",
                forceMoveMarkers: true,
            }
        ]);
        this.beforeCompile();
        this.editor.pushUndoStop();
        this.editor.focus();
    }

    protected dragCurrentPos = { x: 0, y: 0 };
    protected onDragBlockThrottled = Util.throttle(() => {
        const { x, y } = this.dragCurrentPos;
        let mouseTarget = this.editor.getTargetAtClientPoint(x, y);
        if (mouseTarget && mouseTarget.position && this.editor.getPosition() != mouseTarget.position)
            this.editor.setPosition(mouseTarget.position);
        this.editor.focus();
    }, 200);

    protected onPointerMove = (ev: MouseEvent | TouchEvent) => {
        if (this.insertionSnippet) {
            this.dragCurrentPos = {
                x: pxt.BrowserUtils.getClientX(ev),
                y: pxt.BrowserUtils.getClientY(ev)
            }
            this.onDragBlockThrottled(ev);
        }
    };

    protected onPointerUp = (ev: MouseEvent | TouchEvent) => {
        let insertText = this.insertionSnippet;
        this.setInsertionSnippet(undefined);
        if (insertText) {
            // if inline snippet, expects dataTransfer in form "inline:1&qName:name" or "inline:1&[snippet]"
            let inline = pxtc.U.startsWith(insertText, "inline:1&");
            if (inline) insertText = insertText.substring("inline:1&".length);

            let snippetPromise = Promise.resolve(insertText);

            if (pxtc.U.startsWith(insertText, "qName:")) {
                let isPython = this.fileType == pxt.editor.FileType.Python;
                let snippetQName = insertText.substring("qName:".length);

                let initPromise = isPython ? this.parent.saveFileAsync() : Promise.resolve();
                snippetPromise = initPromise.then(() => compiler.snippetAsync(snippetQName, isPython));
            }

            snippetPromise.then(snippet => {
                let mouseTarget = this.editor.getTargetAtClientPoint(pxt.BrowserUtils.getClientX(ev), pxt.BrowserUtils.getClientY(ev));
                let position = mouseTarget.position;
                pxt.tickEvent(`monaco.toolbox.insertsnippet`);
                this.insertSnippet(position, snippet, inline);
            });
        }
    }

    undo() {
        if (!this.editor) return;
        this.editor.trigger('keyboard', 'undo', null);
    }

    redo() {
        if (!this.editor) return;
        this.editor.trigger('keyboard', 'redo', null);
    }

    zoomIn() {
        if (!this.editor) return;
        if (this.parent.settings.editorFontSize >= MAX_EDITOR_FONT_SIZE) return;
        let currentFont = this.getEditorFontSize();
        this.parent.settings.editorFontSize = currentFont + 1;
        this.editor.updateOptions({ fontSize: this.parent.settings.editorFontSize });
        this.forceDiagnosticsUpdate();
    }

    zoomOut() {
        if (!this.editor) return;
        if (this.parent.settings.editorFontSize <= MIN_EDITOR_FONT_SIZE) return;
        let currentFont = this.getEditorFontSize();
        this.parent.settings.editorFontSize = currentFont - 1;
        this.editor.updateOptions({ fontSize: this.parent.settings.editorFontSize });
        this.forceDiagnosticsUpdate();
    }

    private loadReference() {
        Util.assert(this.editor != undefined); // Guarded

        const model = this.editor.getModel();
        const offset = model.getOffsetAt(this.editor.getPosition());
        const source = model.getValue();
        const fileName = this.currFile.name;
        compiler.syntaxInfoAsync("symbol", fileName, offset, source)
            .then(info => {
                if (info?.symbols) {
                    for (const s of info.symbols) {
                        if (s.attributes.help) {
                            this.parent.setSideDoc('/reference/' + s.attributes.help.replace(/^\//, ''));
                            return;
                        }
                    }
                }

                core.warningNotification(Util.lf("Help resource not found"))
            });
    }

    private setupFieldEditors() {
        if (!this.hasFieldEditors || pxt.shell.isReadOnly()) return;
        if (!this.fieldEditors) {
            this.fieldEditors = new FieldEditorManager(this.editor);
            monaco.languages.registerFoldingRangeProvider("typescript", this.fieldEditors);
            monaco.languages.registerFoldingRangeProvider("python", this.fieldEditors);
        }

        this.editor.onDidChangeCursorPosition((e: monaco.editor.ICursorPositionChangedEvent) => {
            if (this.fieldEditors) this.fieldEditors.setCursorLine(e.position.lineNumber);
        });

        pxt.appTarget.appTheme.monacoFieldEditors.forEach(name => {
            const editor = pxt.editor.getMonacoFieldEditor(name);
            if (editor) {
                this.fieldEditors.addFieldEditor(editor);
            }
            else {
                pxt.debug("Skipping unknown monaco field editor '" + name + "'");
            }
        })
    }

    public closeFlyout() {
        if (!this.editor) return;
        this.hideFlyout();
    }

    public hideFlyout() {
        if (this.flyout) this.flyout.setState({ groups: undefined });

        // Hide the current toolbox category
        if (this.toolbox) this.toolbox.clearSelection();

        // Clear editor floats
        this.parent.setState({ hideEditorFloats: false });
    }

    updateToolbox() {
        let appTheme = pxt.appTarget.appTheme;
        if (!appTheme.monacoToolbox || pxt.shell.isReadOnly() || !this.editor) return;
        // Move the monaco editor to make room for the toolbox div
        //this.editor.getLayoutInfo().glyphMarginLeft = 200;
        this.editor.layout();

        if (this.toolbox) {
            this.toolbox.setState({
                loading: false,
                categories: this.getAllCategories(),
                showSearchBox: this.shouldShowSearch()
            })
            if (this.shouldShowToolbox())
                this.toolbox.show();
            else
                this.toolbox.hide();
        }

        this.updateDebuggerToolbox();
    }

    private updateDebuggerToolbox() {
        // update debugger
        const container = document.getElementById('monacoDebuggerToolbox');
        if (!container || !this.blockInfo) return;

        const debugging = this.isDebugging();
        if (debugging && this.flyout) this.flyout.setState({ groups: undefined });
        const debuggerToolbox = debugging ? <DebuggerToolbox
            ref={this.handleDebugToolboxRef}
            parent={this.parent}
            apis={this.blockInfo.apis.byQName}
            openLocation={this.revealBreakpointLocation}
            showCallStack /> : null;
        ReactDOM.render(debuggerToolbox, container);
    }

    getId() {
        return "monacoEditor"
    }

    getViewState() {
        return this.editor ? this.editor.getPosition() : {};
    }

    getCurrentSource() {
        return this.editor ? this.editor.getValue() : this.currSource;
    }

    acceptsFile(file: pkg.File) {
        return true
    }

    private setValue(v: string) {
        this.editor.setValue(v);
    }

    public overrideFile(content: string) {
        Util.assert(this.editor != undefined); // Guarded
        this.editor.setValue(content);
    }

    private shouldShowToolbox(): boolean {
        const readOnly =
            !this.currFile
            || this.currFile.isReadonly()
            || pxt.shell.isReadOnly()
            || this.isDebugging();
        return pxt.appTarget.appTheme.monacoToolbox
            && !readOnly
            && (this.fileType == "typescript" || this.fileType == "python");
    }

    loadFileAsync(file: pkg.File, hc?: boolean): Promise<void> {
        let mode = pxt.editor.FileType.Text;
        this.currSource = file.content;


        const isWinApp = pxt.BrowserUtils.isWinRT();
        if (isWinApp) {
            this.currFile = file;
            return Promise.resolve();
        }

        let loading = document.createElement("div");
        loading.className = "ui inverted loading dimmer active";
        let editorRightArea = document.getElementById("monacoEditorRightArea");
        let editorDiv = document.getElementById("monacoEditorInner");
        editorRightArea.insertBefore(loading, editorDiv);

        this.pythonSourceMap = null;

        return this.loadMonacoAsync()
            .then(() => {
                if (!this.editor) return Promise.resolve();

                this.foldFieldEditorRanges = true;
                this.updateFieldEditors();

                let ext = file.getExtension()
                if (modeMap.hasOwnProperty(ext)) mode = modeMap[ext]
                this.fileType = mode

                const readOnly = file.isReadonly() || pxt.shell.isReadOnly() || this.isDebugging();
                this.editor.updateOptions({ readOnly: readOnly });

                let proto = "pkg:" + file.getName();
                let model = monaco.editor.getModels().filter((model) => model.uri.toString() == proto)[0];
                if (!model) model = monaco.editor.createModel(pkg.mainPkg.readFile(file.getName()), mode, monaco.Uri.parse(proto));
                if (model) this.editor.setModel(model);

                this.defineEditorTheme(hc);
                // Set the current file
                this.currFile = file;
                // update toolbox
                if (this.shouldShowToolbox()) {
                    this.beginLoadToolbox(file, hc);
                } else {
                    if (this.toolbox)
                        this.toolbox.hide();
                }

                this.setValue(file.content)
                this.setDiagnostics(file, this.snapshotState())

                if (this.breakpoints) {
                    this.breakpoints.loadBreakpointsForFile(file, this.editor);
                    const loc = this.breakpoints.getLocationOfBreakpoint(this.highlightedBreakpoint);
                    if (loc && loc.fileName === file.getTextFileName()) {
                        this.highilightStatementCore(loc, true);
                    }
                }

                if (this.fileType == pxt.editor.FileType.Markdown)
                    this.parent.setSideMarkdown(file.content);

                this.currFile.setForceChangeCallback((from: string, to: string) => {
                    if (from != to) {
                        pxt.debug(`File changed (from ${from}, to ${to}). Reloading editor`)
                        this.loadFileAsync(this.currFile);
                    }
                });

                if (!file.isReadonly()) {
                    model.onDidChangeContent((e: monaco.editor.IModelContentChangedEvent) => {
                        // Remove any Highlighted lines
                        this.clearHighlightedStatements();

                        // Remove any current error shown, as a change has been made.
                        let viewZones = this.editorViewZones || [];
                        (this.editor as any).changeViewZones(function (changeAccessor: any) {
                            viewZones.forEach((id: any) => {
                                changeAccessor.removeZone(id);
                            });
                        });
                        this.editorViewZones = [];

                        const bannedCharactersRegex = /[\u{201c}\u{201d}\u{2018}\u{2019}]/u;

                        // Test for left and right quotes because ios safari will sometimes insert
                        // them automatically for the user. Convert them to normal quotes
                        if (e.changes.some(change => bannedCharactersRegex.test(change.text))) {
                            const edits: monaco.editor.IIdentifiedSingleEditOperation[] = e.changes.filter(e => bannedCharactersRegex.test(e.text)).map(e => {
                                const start = model.getPositionAt(e.rangeOffset);
                                const end = model.getPositionAt(e.rangeOffset + e.text.length);
                                return {
                                    range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                                    text: e.text.replace(/\u{201c}|\u{201d}/gu, `"`).replace(/\u{2018}|\u{2019}/gu, `'`)
                                }
                            });

                            this.editor.executeEdits("pxt", edits);
                        }

                        this.updateDiagnostics();
                        this.changeCallback();
                        this.updateFieldEditors();
                    });
                }

                this.resize();
                this.hideFlyout();

                // Get extension packages
                this.extensions = pkg.allEditorPkgs()
                    .map(ep => ep.getKsPkg())
                    // Make sure the package has extensions enabled, and is a github package.
                    // Extensions are limited to github packages and ghpages, as we infer their url from the installedVersion config
                    .filter(p => !!p && p.config && !!p.config.extension && /^(file:|github:)/.test(p.installedVersion));

                if (this.giveFocusOnLoading) {
                    this.editor.focus();
                }

                // this monitors the text buffer for "edit amendments". See monacoEditAmendments for more.
                // This is an extension we made to Monaco that allows us to replace full lines of text when
                // using code completion.
                if (this.fileType === pxt.editor.FileType.Python)
                    this.editAmendmentsListener = listenForEditAmendments(this.editor);

                return this.foldFieldEditorRangesAsync()
            }).finally(() => {
                editorRightArea.removeChild(loading);
                // Do Not Remove: This is used by the skillmap
                if (this.parent.isTutorial()) pxt.tickEvent("tutorial.editorLoaded")
            });
    }

    unloadFileAsync(): Promise<void> {
        if (this.toolbox)
            this.toolbox.clearSearch();
        if (this.currFile && this.currFile.getName() == "this/" + pxt.CONFIG_NAME) {
            // Reload the header if a change was made to the config file: pxt.json
            return this.parent.reloadHeaderAsync();
        }
        if (this.editAmendmentsListener) {
            this.editAmendmentsListener.dispose();
            this.editAmendmentsListener = undefined;
        }

        return Promise.resolve();
    }

    private beginLoadToolbox(file: pkg.File, hc?: boolean) {
        if (this.toolbox)
            this.toolbox.showLoading();
        compiler.getBlocksAsync().then(bi => {
            this.blockInfo = bi
            this.nsMap = this.partitionBlocks();
            this.updateToolbox();
            pxt.vs.syncModels(pkg.mainPkg, this.extraLibs, file.getName(), file.isReadonly())
            this.defineEditorTheme(hc, true);
        });
        this.blockIdMap = snippets.blockIdMap();
    }

    snapshotState() {
        return this.editor && this.editor.getModel() ? this.editor.getModel().getLinesContent() : null;
    }

    setViewState(pos: monaco.IPosition) {
        if (!this.editor) return;
        if (!pos || Object.keys(pos).length === 0) return;
        this.editor.setPosition(pos)
        this.editor.setScrollPosition({
            scrollTop: this.editor.getTopForLineNumber(pos.lineNumber)
        });
    }

    setBreakpointsMap(breakpoints: pxtc.Breakpoint[], procCallLocations: pxtc.LocationInfo[]): void {
        this.callLocations = procCallLocations;
        if (this.isDebugging()) {
            if (!this.breakpoints) {
                this.breakpoints = new BreakpointCollection(breakpoints, this.pythonSourceMap);
                this.breakpoints.loadBreakpointsForFile(this.currFile, this.editor);
            }

            if (this.fieldEditors) this.fieldEditors.clearRanges(this.editor);
            if (this.feWidget) this.feWidget.close();
            if (this.editor) this.editor.updateOptions({ readOnly: true });
        }
        else {
            if (this.editor) {
                this.editor.updateOptions({
                    readOnly: pxt.shell.isReadOnly() || (this.currFile && this.currFile.isReadonly())
                });
            }

            if (this.breakpoints) {
                this.breakpoints.dispose();
                this.breakpoints = undefined;
            }
            this.updateFieldEditors();
        }
    }

    setDiagnostics(file: pkg.File, snapshot: string[]) {
        if (!this.editor || this.currFile !== file)  // async outdated set diagnostics
            return;
        this.diagSnapshot = snapshot
        this.forceDiagnosticsUpdate()
    }

    updateDiagnostics() {
        if (this.needsDiagUpdate())
            this.forceDiagnosticsUpdate();
    }

    getBreakpoints() {
        return this.breakpoints ? this.breakpoints.getActiveBreakpoints() : [];
    }

    protected getEditorFontSize() {
        return this.editor.getOptions().get(monaco.editor.EditorOption.fontInfo).fontSize;
    }

    private sendBreakpoints() {
        if (this.breakpoints) {
            simulator.driver.setBreakpoints(this.getBreakpoints());
        }
    }

    private needsDiagUpdate() {
        if (!this.annotationLines) return false
        let lines: string[] = this.editor.getModel().getLinesContent()
        for (let line of this.annotationLines) {
            if (this.diagSnapshot[line] !== lines[line])
                return true;
        }
        return false;
    }

    private forceDiagnosticsUpdate() {
        if (this.fileType != pxt.editor.FileType.TypeScript
            && this.fileType != pxt.editor.FileType.Python) return

        let file = this.currFile
        let monacoErrors: monaco.editor.IMarkerData[] = []

        if (file && file.diagnostics) {
            const model = monaco.editor.getModel(monaco.Uri.parse(`pkg:${file.getName()}`))
            for (let d of file.diagnostics) {
                const addErrorMessage = (message: string) => {
                    monacoErrors.push({
                        severity: monaco.MarkerSeverity.Error,
                        message: message,
                        startLineNumber: d.line + 1,
                        startColumn: d.column + 1,
                        endLineNumber: d.endLine == undefined ? endPos.lineNumber : d.endLine + 1,
                        endColumn: d.endColumn == undefined ? endPos.column : d.endColumn
                    })
                }
                const endPos = model.getPositionAt(d.start + d.length);
                if (typeof d.messageText === 'string') {
                    addErrorMessage(d.messageText as string);
                } else {
                    let curr = d.messageText as ts.DiagnosticMessageChain;
                    while (curr.next != undefined) {
                        addErrorMessage(curr.messageText);
                        curr = curr.next;
                    }
                }
            }
            monaco.editor.setModelMarkers(model, 'typescript', monacoErrors);

            // report errors to anyone listening (e.g. the error list)
            this.onErrorChanges(file.diagnostics);
        }
    }

    showFieldEditor(range: monaco.Range, fe: pxt.editor.MonacoFieldEditor, viewZoneHeight: number, buildAfter: boolean) {
        if (this.feWidget) {
            this.feWidget.close();
        }
        this.feWidget = new ModalEditorHost(fe, range, this.editor.getModel());
        // this.feWidget.heightInPx = viewZoneHeight;

        const triggerRebuildIfNeeded = () => {
            if (buildAfter) {
                simulator.setDirty();

                if (this.fileType == "typescript") {
                    // If the field editor changed something then we can't guarantee that
                    // using a cached decompile is safe
                    pkg.mainEditorPkg().invalidateCachedTranspile("ts", this.getCurrentSource(), "blocks");
                }
            }
        }

        this.feWidget.showAsync(this.fileType, this.editor)
            .then(edit => {
                this.activeRangeID = null;
                if (edit) {
                    this.editModelAsync(edit.range, edit.replacement)
                        .then(newRange => this.indentRangeAsync(newRange))
                        .then(() => this.foldFieldEditorRangesAsync())
                        .then(triggerRebuildIfNeeded)
                }
                else {
                    triggerRebuildIfNeeded();
                }
            })
    }

    protected updateFieldEditors() {
        if (this.fieldEditors) {
            this.fieldEditors.setFieldEditorsEnabled(this.hasFieldEditors && this.editor && !pxt.shell.isReadOnly() && !this.isDebugging());
        }
    }

    protected foldFieldEditorRangesAsync() {
        if (this.foldFieldEditorRanges) {
            return this.editor.getAction("editor.foldAllBlockComments").run()
        }
        return Promise.resolve();
    }

    highlightStatement(stmt: pxtc.LocationInfo, brk?: pxsim.DebuggerBreakpointMessage) {
        if (!stmt) {
            this.clearHighlightedStatements();
            if (this.debuggerToolbox) this.debuggerToolbox.setBreakpoint(null);
            return false;
        }
        else if (!this.editor) {
            return false;
        }

        if (brk && this.breakpoints?.getLoadedBreakpoint(brk.breakpointId)) stmt = this.breakpoints.getLoadedBreakpoint(brk.breakpointId);
        else if (this.currFile.getExtension() === "py" && this.pythonSourceMap) stmt = this.pythonSourceMap.ts.locToLoc(stmt);

        if (this.currFile.getTextFileName() !== stmt.fileName && this.isDebugging() && lookupFile(stmt.fileName)) {
            this.parent.setFile(lookupFile(stmt.fileName))
        }
        else if (!this.highilightStatementCore(stmt, !!brk)) {
            return false;
        }

        this.highlightedBreakpoint = brk ? brk.breakpointId : undefined;

        if (brk && this.isDebugging() && this.debuggerToolbox) {
            this.debuggerToolbox.setBreakpoint(brk);
            this.resize();
        }

        return true;
    }

    protected highilightStatementCore(stmt: pxtc.LocationInfo, centerOnLocation = false) {
        let position = this.editor.getModel().getPositionAt(stmt.start);
        let end = this.editor.getModel().getPositionAt(stmt.start + stmt.length);
        if (!position || !end) return false;
        this.highlightDecorations = this.editor.deltaDecorations(this.highlightDecorations, [
            {
                range: new monaco.Range(position.lineNumber, position.column, end.lineNumber, end.column),
                options: { inlineClassName: 'highlight-statement' }
            },
        ]);

        if (centerOnLocation) this.editor.revealPositionInCenter(position);

        return true;
    }

    clearHighlightedStatements() {
        if (this.editor && this.highlightDecorations)
            this.editor.deltaDecorations(this.highlightDecorations, []);
    }

    private partitionBlocks() {
        const res: pxt.Map<toolbox.BlockDefinition[]> = {};
        this.topBlocks = [];

        const builtInBlocks = snippets.allBuiltinBlocksByName();

        const that = this;
        function setSubcategory(ns: string, subcat: string) {
            if (!that.subcategoryMap[ns]) that.subcategoryMap[ns] = {};
            that.subcategoryMap[ns][subcat] = true;
        }

        this.blockInfo.blocks.forEach(fn => {
            let ns = (fn.attributes.blockNamespace || fn.namespace).split('.')[0];

            // Don't add the block if there exists a block with the same definition
            if (builtInBlocks[fn.qName]
                // ignore blocks artifacts
                || fn.attributes.shim == "TD_ID")
                return;

            if (!res[ns]) {
                res[ns] = [];
            }
            res[ns].push(fn);

            const subcat = fn.attributes.subcategory;
            const advanced = fn.attributes.advanced;

            if (advanced) {
                // More subcategory
                setSubcategory(ns, lf("more"));
            } else if (subcat) {
                setSubcategory(ns, subcat);
            }

            if (fn.attributes.topblock) {
                this.topBlocks.push(fn);
            }
        });

        if (snippets.getPauseUntil()) {
            const cat = pxt.appTarget.runtime.pauseUntilBlock.category;
            if (res[cat]) {
                res[cat].push(snippets.getPauseUntil());
            }
        }

        return res;
    }

    ///////////////////////////////////////////////////////////
    ////////////         Toolbox methods          /////////////
    ///////////////////////////////////////////////////////////

    clearCaches() {
        super.clearCaches();
        snippets.clearBuiltinBlockCache();
    }

    shouldShowSearch() {
        if (this.parent.state.editorState && this.parent.state.editorState.searchBar != undefined) {
            return this.parent.state.editorState.searchBar;
        }
        return true;
    }

    getBuiltinCategory(ns: string): toolbox.ToolboxCategory {
        return snippets.getBuiltinCategory(ns);
    }

    isBuiltIn(ns: string): boolean {
        return snippets.isBuiltin(ns);
    }

    getNamespaceAttrs(ns: string) {
        const builtin = snippets.getBuiltinCategory(ns);
        if (builtin) {
            builtin.attributes.color = pxt.toolbox.getNamespaceColor(builtin.nameid);
            return builtin.attributes;
        }
        if (!this.blockInfo) return undefined;

        return super.getNamespaceAttrs(ns);
    }

    getNamespaces() {
        const namespaces = Object.keys(this.nsMap)
            .filter(ns => !snippets.isBuiltin(ns) && !!this.getNamespaceAttrs(ns));

        function isRemoved(ns: string): boolean {
            return snippets.getBuiltinCategory(ns).removed;
        }

        let config = pxt.appTarget.runtime || {};
        if (config.loopsBlocks && !isRemoved(toolbox.CategoryNameID.Loops)) namespaces.push(toolbox.CategoryNameID.Loops);
        if (config.logicBlocks && !isRemoved(toolbox.CategoryNameID.Logic)) namespaces.push(toolbox.CategoryNameID.Logic);
        if (config.variablesBlocks && !isRemoved(toolbox.CategoryNameID.Variables)) namespaces.push(toolbox.CategoryNameID.Variables);
        if (config.mathBlocks && !isRemoved(toolbox.CategoryNameID.Maths)) namespaces.push(toolbox.CategoryNameID.Maths);
        if (config.functionBlocks && !isRemoved(toolbox.CategoryNameID.Functions)) namespaces.push(toolbox.CategoryNameID.Functions);
        if (config.listsBlocks && !isRemoved(toolbox.CategoryNameID.Arrays)) namespaces.push(toolbox.CategoryNameID.Arrays);
        if (config.textBlocks && !isRemoved(toolbox.CategoryNameID.Text)) namespaces.push(toolbox.CategoryNameID.Text);

        if (pxt.appTarget.cloud && pxt.appTarget.cloud.packages) {
            namespaces.push(toolbox.CategoryNameID.Extensions);
        }

        return namespaces.concat(super.getNamespaces());
    }

    public moveFocusToToolbox = () => {
        // Set focus in toolbox
        if (this.toolbox) this.toolbox.focus();
    }

    public moveFocusToFlyout() {
        if (this.flyout) {
            let firstBlock = document.querySelector(".monacoBlock") as HTMLElement;
            if (firstBlock) {
                firstBlock.focus();
                firstBlock.click();
            }
        }
    }

    ///////////////////////////////////////////////////////////
    ////////////         Flyout methods           /////////////
    ///////////////////////////////////////////////////////////

    public getBlocksForCategory(ns: string, subns?: string): toolbox.BlockDefinition[] {
        if (!snippets.isBuiltin(ns)) {
            return this.filterBlocks(subns, this.nsMap[ns]);
        }
        else {
            return this.getBuiltinBlocks(ns, subns);
        }
    }

    private filterBlocks(subns: string, blocks: toolbox.BlockDefinition[]) {
        return blocks.filter((block => !(block.attributes.blockHidden)
            && !(block.attributes.deprecated && !this.parent.isTutorial())
            && (block.name.indexOf('_') != 0)
            && ((!subns && !block.attributes.subcategory && !block.attributes.advanced)
                || (subns && ((block.attributes.advanced && subns == lf("more"))
                    || (block.attributes.subcategory && subns == block.attributes.subcategory))))));
    }

    private getBuiltinBlocks(ns: string, subns: string) {
        let cat = snippets.getBuiltinCategory(ns);
        let blocks = cat.blocks || [];
        if (!cat.custom && this.nsMap[ns]) blocks = blocks.concat(this.nsMap[ns].filter(block => !(block.attributes.blockHidden) && !(block.attributes.deprecated && !this.parent.isTutorial())));
        return this.filterBlocks(subns, blocks);
    }

    // Passes blocks to MonacoFlyout component to render
    public showFlyout(treeRow: toolbox.ToolboxCategory) {
        if (!this.editor) return;
        let { nameid: ns, name, subns, color, icon, blocks } = treeRow;
        let groups: toolbox.GroupDefinition[] = [];

        if (this.flyout) {
            if (ns == 'search') {
                try {
                    blocks = this.getSearchBlocks();
                    if (blocks.length == 0) {
                        name = lf("No search results...");
                    }
                    groups.push({ name: pxt.DEFAULT_GROUP_NAME, blocks });
                }
                catch (e) {
                    pxt.reportException(e);
                    blocks = [];
                    name = lf("No search results...");
                }
            } else if (ns == 'topblocks') {
                blocks = this.getTopBlocks();

                if (blocks.length == 0) {
                    name = lf("No basic results...");
                } else {
                    // Show a heading
                    color = pxt.toolbox.getNamespaceColor('topblocks');
                    icon = pxt.toolbox.getNamespaceIcon('topblocks');
                    name = lf("{id:category}Basic");
                    groups.push({ name: pxt.DEFAULT_GROUP_NAME, blocks });
                }
            } else {
                groups = this.getBlockGroups(treeRow);
            }

            this.flyout.setState({
                name: name || Util.capitalize(subns || ns),
                selectedBlock: undefined,
                hide: false,
                ns, color, icon, groups
            })
        }
    }

    protected showFlyoutHeadingLabel(ns: string, name: string, subns: string, icon: string, color: string) {
    }

    protected showFlyoutGroupLabel(group: string, groupicon: string, labelLineWidth: string, helpCallback: string) {
    }

    protected showFlyoutBlocks(ns: string, color: string, blocks: toolbox.BlockDefinition[]) {
    }

    protected handleGutterClick(e: monaco.editor.IEditorMouseEvent) {
        const line = e.target.position.lineNumber;

        if (this.isDebugging()) {
            // Set/unset the nearest breakpoint;
            if (this.breakpoints) {
                this.breakpoints.toggleBreakpointAt(line);
                this.sendBreakpoints();
            }
        }
        else if (this.fieldEditors) {
            // Open/close any field editors in range
            const model = this.editor.getModel();
            const decorations = model.getDecorationsInRange(new monaco.Range(line, model.getLineMinColumn(line), line, model.getLineMaxColumn(line)));
            if (decorations.length) {
                const lineInfo = this.fieldEditors.getInfoForLine(line);
                if (lineInfo) {
                    if (this.feWidget && this.activeRangeID != null && lineInfo.id === this.activeRangeID) {
                        this.feWidget.close();
                        this.activeRangeID = null;
                        return;
                    }
                    else {
                        this.activeRangeID = lineInfo.id;
                    }

                    const fe = this.fieldEditors.getFieldEditorById(lineInfo.owner);
                    if (fe) {
                        this.showFieldEditor(lineInfo.range, new fe.proto(), fe.heightInPixels || 500, fe.alwaysBuildOnClose);
                    }
                }
            }
        }
    }

    protected revealBreakpointLocation = (id: number, frameIndex: number) => {
        if (!this.breakpoints) return;

        const loc = this.breakpoints.getLocationOfBreakpoint(id);
        if (!loc) return;

        this.highlightedBreakpoint = id;

        if (this.currFile.getTextFileName() !== loc.fileName) {
            const mainPkg = pkg.mainEditorPkg()
            if (lookupFile(loc.fileName)) {
                this.parent.setFile(lookupFile(loc.fileName))
            }
        }
        else {
            this.highilightStatementCore(loc, true);
        }

        if (this.debuggerToolbox) this.debuggerToolbox.setState({ currentFrame: frameIndex });
    }

    private getSearchBlocks(): toolbox.BlockDefinition[] {
        let results: toolbox.BlockDefinition[] = [];
        const searchBlocks = this.toolbox.getSearchBlocks();

        const that = this;
        function getNamespaceColor(ns: string) {
            const nsinfo = that.blockInfo.apis.byQName[ns];
            const color =
                (nsinfo ? nsinfo.attributes.color : undefined)
                || pxt.toolbox.getNamespaceColor(ns)
                || `255`;
            return color;
        }

        searchBlocks.forEach((block) => {
            if (!block.name) {
                if (block.attributes.blockId == pxtc.PAUSE_UNTIL_TYPE) {
                    const pauseUntilBlock = snippets.getPauseUntil();
                    if (pauseUntilBlock) {
                        const ns = pauseUntilBlock.attributes.blockNamespace;
                        pauseUntilBlock.attributes.color = getNamespaceColor(ns);
                        results.push(pauseUntilBlock);
                    }
                } else {
                    // For built in blocks, let's search from monaco snippets
                    const builtin = snippets.allBuiltinBlocks()[block.attributes.blockId];
                    if (builtin) {
                        builtin[0].attributes.blockNamespace = builtin[1];
                        results.push(builtin[0]);
                    } else {
                        pxt.log("couldn't find buildin search qName for block: " + block.attributes.blockId);
                    }
                }
            } else {
                const fn = this.blockInfo.apis.byQName[block.name];
                if (fn) {
                    if (fn.name.indexOf('_') == 0) return;
                    const ns = (fn.attributes.blockNamespace || fn.namespace).split('.')[0];
                    fn.attributes.color = fn.attributes.color || getNamespaceColor(ns);
                    results.push(fn);
                } else {
                    pxt.log("couldn't find non builtin search by qName: " + block.name);
                }
            }
        })

        return results;
    }

    // Snippet as string, or "qName:" + qualified name of block
    public setInsertionSnippet = (snippet: string) => {
        this.insertionSnippet = snippet;
    }

    // Check if insertion snippet is currently set
    public hasInsertionSnippet = (): boolean => {
        return !!this.insertionSnippet;
    }

    ///////////////////////////////////////////////////////////
    ////////////          Block methods           /////////////
    ///////////////////////////////////////////////////////////

    private uniqueBlockId = 0; // Used for hex blocks

    private indentRangeAsync(range: monaco.IRange): Promise<monaco.IRange> {
        const model = this.editor.getModel();

        const minIndent = model.getLineFirstNonWhitespaceColumn(range.startLineNumber) - 1;
        const innerIndent = createIndent(model.getOptions().indentSize + minIndent);
        const lines = model.getValueInRange(range).split(/\n/);

        const newText = lines.map((line, index) => {
            if (index === 0) {
                return line.trim();
            }
            else if (index === lines.length - 1) {
                return createIndent(minIndent) + line.trim();
            }
            else {
                return innerIndent + line.trim();
            }
        }).join(model.getEOL());

        return this.editModelAsync(range, newText);
    }

    private editModelAsync(range: monaco.IRange, newText: string): Promise<monaco.IRange> {
        return new Promise(resolve => {
            const model = this.editor.getModel();
            const lines = newText.split("\n");
            const afterRange = new monaco.Range(range.startLineNumber, range.startColumn,
                range.startLineNumber + lines.length - 1, lines[lines.length - 1].length)

            let disposable = this.editor.onDidChangeModelContent(e => {
                if (disposable) {
                    disposable.dispose();
                    disposable = undefined
                }
                this.editor.setSelection(afterRange);

                // Clear ranges because the model changed
                if (this.fieldEditors) this.fieldEditors.clearRanges(this.editor);
                resolve(afterRange);
            });

            model.pushEditOperations(this.editor.getSelections(), [{
                range: model.validateRange(range),
                text: newText,
                forceMoveMarkers: true
            }], inverseOp => [rangeToSelection(inverseOp[0].range)]);
        });
    }

    private isDebugging() {
        return this.parent.state.debugging;
    }

    private handleToolboxRef = (c: toolbox.Toolbox) => {
        this.toolbox = c;
    }

    private handleDebugToolboxRef = (ref: DebuggerToolbox) => {
        if (ref) {
            this.debuggerToolbox = ref;
            if (this.isDebugging()) this.updateToolbox();
        }
    }

    private handleFlyoutRef = (ref: MonacoFlyout) => {
        if (ref) { this.flyout = ref; }
    }

    protected getEditorColor() {
        if (pxt.appTarget.appTheme.monacoColors && pxt.appTarget.appTheme.monacoColors["editor.background"]) {
            return pxt.appTarget.appTheme.monacoColors["editor.background"]
        }
        else if (pxt.appTarget.appTheme.invertedMonaco) {
            return "#1e1e1e"
        }
        else {
            return "#ffffff"
        }
    }
}

export function rangeToSelection(range: monaco.IRange): monaco.Selection {
    return new monaco.Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
}

/**
 * This is mostly copied from vscode. Monaco does not properly detect iPads on ios 13
 * because they pretend to be desktops. If Monaco ever fixes this bug, this should be removed.
 */
class ShowKeyboardWidget implements monaco.editor.IOverlayWidget {
    private static readonly ID = 'editor.contrib.ShowKeyboardWidget_pxt';
    private readonly editor: monaco.editor.ICodeEditor;
    private readonly _domNode: HTMLElement;

    constructor(editor: monaco.editor.ICodeEditor) {
        this.editor = editor;
        this._domNode = document.createElement('textarea');
        this._domNode.className = 'iPadShowKeyboard';

        this._domNode.addEventListener("touchstart", this.touchHandler);
        this._domNode.addEventListener("focus", this.touchHandler);

        this.editor.addOverlayWidget(this);
    }

    public dispose(): void {
        this.editor.removeOverlayWidget(this);

        this._domNode.removeEventListener("touchstart", this.touchHandler);
        this._domNode.removeEventListener("focus", this.touchHandler);
    }

    public getId(): string {
        return ShowKeyboardWidget.ID;
    }

    public getDomNode(): HTMLElement {
        return this._domNode;
    }

    public getPosition(): monaco.editor.IOverlayWidgetPosition {
        return {
            preference: monaco.editor.OverlayWidgetPositionPreference.TOP_RIGHT_CORNER
        };
    }

    protected touchHandler = () => {
        this.editor.focus();
    }
}

function createIndent(length: number) {
    let res = '';
    for (let i = 0; i < length; i++) res += " ";
    return res;
}

function lookupFile(file: string): pkg.File {
    const mPkg = pkg.mainEditorPkg();
    if (mPkg.files[file]) return mPkg.files[file];

    const found = mPkg.lookupFile(file);

    if (found) return found;

    return undefined;
}
