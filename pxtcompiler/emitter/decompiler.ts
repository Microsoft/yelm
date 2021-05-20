namespace ts.pxtc.decompiler {
    export enum DecompileParamKeys {
        // Field editor should decompile literal expressions in addition to
        // call expressions
        DecompileLiterals = "decompileLiterals",

        // Tagged template name expected by a field editor for a parameter
        // (i.e. for tagged templates with blockIdentity set)
        TaggedTemplate = "taggedTemplate",

        // Allow for arguments for which fixed instances exist to be decompiled
        // even if the expression is not a direct reference to a fixed instance
        DecompileIndirectFixedInstances = "decompileIndirectFixedInstances",

        // When set on a function, the argument expression will be passed up
        // as a string of TypeScript code instead of being decompiled into blocks. The
        // field editor is expected to parse the code itself and also preserve it
        // if the valus is invalid (like a grey-block would)
        DecompileArgumentAsString = "decompileArgumentAsString"
    }

    export interface CommentInfo {
        kind: CommentKind;
        hasTrailingNewline: boolean;
        followedByEmptyLine: boolean;
        isTrailingComment: boolean;

        start: number;
        end: number;
        owner?: Node;
        ownerStatement?: StatementNode;
    }

    export enum CommentKind {
        SingleLine,
        MultiLine
    }

    export interface MultiLineComment extends CommentInfo {
        kind: CommentKind.MultiLine;
        lines: string[];
    }

    export interface SingleLineComment extends CommentInfo {
        kind: CommentKind.SingleLine;
        text: string;
    }

    export type Comment = MultiLineComment | SingleLineComment;

    export const FILE_TOO_LARGE_CODE = 9266;
    export const DECOMPILER_ERROR = 9267;

    interface DecompileModuleExport {
        name: string;
        initializer: string;
    }

    interface DecompilerCallInfo extends pxtc.CallInfo {
        decompilerBlockAlias?: string;
    }

    const SK = ts.SyntaxKind;

    /**
     * Max number of blocks before we bail out of decompilation
     */
    const MAX_BLOCKS = 1500;

    const lowerCaseAlphabetStartCode = 97;
    const lowerCaseAlphabetEndCode = 122;

    // Bounds for decompilation of workspace comments
    const minCommentWidth = 160;
    const minCommentHeight = 120;
    const maxCommentWidth = 480;
    const maxCommentHeight = 360;

    const validStringRegex = /^[^\f\n\r\t\v\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/;
    const arrayTypeRegex = /^(?:Array<(.+)>)|(?:(.+)\[\])$/;

    interface DecompilerEnv {
        blocks: BlocksInfo;
        declaredFunctions: pxt.Map<ts.FunctionDeclaration>;
        functionParamIds: pxt.Map<pxt.Map<string>>; // Maps a function name to a map of paramName => paramId
        declaredEnums: pxt.Map<boolean>;
        declaredKinds?: pxt.Map<KindDeclarationInfo>;
        tileset: pxt.sprite.legacy.LegacyTileInfo[];
        attrs: (c: pxtc.CallInfo) => pxtc.CommentAttrs;
        compInfo: (c: pxtc.CallInfo) => pxt.blocks.BlockCompileInfo;
        localReporters: PropertyDesc[][]; // A stack of groups of locally scoped argument declarations, to determine whether an argument should decompile as a reporter or a variable
        opts: DecompileBlocksOptions;
        aliasBlocks: pxt.Map<string>; // A mapping of qualified names to qualified names of blocks that use blockAliasFor
    }

    interface KindDeclarationInfo {
        kindInfo: pxtc.KindInfo;
        declaredNames: string[];
    }

    interface DecompileArgument {
        value: Expression;
        param: pxt.blocks.BlockParameter;
        info: ParameterDesc;
    }

    const numberType = "math_number";
    const minmaxNumberType = "math_number_minmax";
    const integerNumberType = "math_integer";
    const wholeNumberType = "math_whole_number";
    const stringType = "text";
    const booleanType = "logic_boolean";

    const ops: pxt.Map<{ type: string; op?: string; leftName?: string; rightName?: string }> = {
        "+": { type: "math_arithmetic", op: "ADD" },
        "-": { type: "math_arithmetic", op: "MINUS" },
        "/": { type: "math_arithmetic", op: "DIVIDE" },
        "*": { type: "math_arithmetic", op: "MULTIPLY" },
        "**": { type: "math_arithmetic", op: "POWER" },
        "%": { type: "math_modulo", leftName: "DIVIDEND", rightName: "DIVISOR" },
        "<": { type: "logic_compare", op: "LT" },
        "<=": { type: "logic_compare", op: "LTE" },
        ">": { type: "logic_compare", op: "GT" },
        ">=": { type: "logic_compare", op: "GTE" },
        "==": { type: "logic_compare", op: "EQ" },
        "===": { type: "logic_compare", op: "EQ" },
        "!=": { type: "logic_compare", op: "NEQ" },
        "!==": { type: "logic_compare", op: "NEQ" },
        "&&": { type: "logic_operation", op: "AND" },
        "||": { type: "logic_operation", op: "OR" },
    }

    /*
     * Matches a single line comment and extracts the text.
     * Breakdown:
     *     ^\s*     - matches leading whitespace
     *      \/\/s*  - matches double slash
     *      (.*)    - matches rest of the comment
     */
    const singleLineCommentRegex = /^\s*\/\/\s*(.*)$/

    /*
     * Matches one line of a multi-line comment and extracts the text.
     * Breakdown:
     *      ^\s*                                        - matches leading whitespace
     *      (?:\/\*\*?)                                 - matches beginning of a multi-line comment (/* or /**)
     *      (?:\*)                                      - matches a single asterisk that might begin a line in the body of the comment
     *      (?:(?:(?:\/\*\*?)|(?:\*))(?!\/))            - combines the previous two regexes but does not match either if followed by a slash
     *      ^\s*(?:(?:(?:\/\*\*?)|(?:\*))(?!\/))?\s*    - matches all possible beginnings of a multi-line comment line (/*, /**, *, or just whitespace)
     *      (.*?)                                       - matches the text of the comment line
     *      (?:\*?\*\/)?$                               - matches the end of the multiline comment (one or two asterisks and a slash) or the end of a line within the comment
     */
    const multiLineCommentRegex = /^\s*(?:(?:(?:\/\*\*?)|(?:\*))(?!\/))?\s*(.*?)(?:\*?\*\/)?$/

    /**
     * Despite the name, the only "variables" we emit are for enum members
     */
    interface BlocklyVariableDeclaration {
        name: string;
        type: string;
    }

    interface BlocklyNode {
        kind: string;
    }

    interface TextNode {
        kind: "text";
        value: string;
    }

    interface FieldNode extends BlocklyNode {
        kind: "field";
        name: string;
        value: string | number;
    }

    interface ValueNode extends BlocklyNode {
        kind: "value";
        name: string;
        value: OutputNode;
        shadowType?: string;
        shadowMutation?: pxt.Map<string>;
    }

    interface MutationChild {
        attributes: pxt.Map<string>;
        nodeName: string;
    }

    interface BlockNode extends BlocklyNode {
        type: string;
        inputs?: ValueNode[];
        fields?: FieldNode[]
        mutation?: pxt.Map<string>;
        mutationChildren?: MutationChild[]; // Mutation child tags
    }

    interface ExpressionNode extends BlockNode {
        kind: "expr";
        handlers?: Handler[];
        isShadow?: boolean;
        id?: string;
    }

    interface StatementNode extends BlockNode {
        kind: "statement";
        handlers?: Handler[];
        next?: StatementNode;
        prev?: StatementNode;
        comment?: Comment[];
        id?: string;

        // Optional data that Blockly ignores. We use it to associate statements with workspace comments
        data?: string;
    }

    interface EventHandlerNode extends BlockNode {
        kind: "event";
        handler: Handler;
    }

    interface Handler {
        name: string,
        statement: StatementNode
    }

    interface WorkspaceComment {
        // Used for grouping comments and statements
        refId: string;
        comment: Comment[];
    }

    type OutputNode = ExpressionNode | TextNode;

    export interface RenameLocation {
        name: string;
        diff: number;
        span: ts.TextSpan;
    }

    export class RenameMap {
        constructor(private renames: RenameLocation[]) {
            this.renames.sort((a, b) => a.span.start - b.span.start);
        }

        public getRenamesInSpan(start: number, end: number) {
            const res: RenameLocation[] = [];

            for (const rename of this.renames) {
                if (rename.span.start > end) {
                    break;
                }

                else if (rename.span.start >= start) {
                    res.push(rename);
                }
            }

            return res;
        }

        public getRenameForPosition(position: number) {
            for (const rename of this.renames) {
                if (rename.span.start > position) {
                    return undefined;
                }
                else if (rename.span.start === position) {
                    return rename;
                }
            }
            return undefined;
        }
    }

    export type RenameMapOpts = {
        declarations: "variables" | "all"
        takenNames: NamesSet,
    }
    export type NamesSet = pxt.Map<boolean | {}>
    /**
     * Uses the language service to ensure that there are no duplicate variable
     * names in the given file. All variables in Blockly are global, so this is
     * necessary to prevent local variables from colliding.
     */
    export function buildRenameMap(p: Program, s: SourceFile,
        { declarations, takenNames }: RenameMapOpts = { declarations: "variables", takenNames: {} }): [RenameMap, NamesSet] {
        let service = ts.createLanguageService(new LSHost(p))
        const allRenames: RenameLocation[] = [];

        let names = collectNameCollisions();

        return [new RenameMap(allRenames), names];

        function collectNameCollisions(): NamesSet {

            checkChildren(s);

            function checkChildren(n: Node): void {
                ts.forEachChild(n, (child) => {
                    if (isDeclarationName(child)
                        && (declarations === "all" || ts.isVariableDeclaration(child.parent))) {
                        const name = child.getText();

                        if (takenNames[name]) {
                            const newName = getNewName(name, takenNames);
                            const renames = service.findRenameLocations(s.fileName, child.pos + 1, false, false);
                            if (renames) {
                                renames.forEach(r => {
                                    allRenames.push({
                                        name: newName,
                                        diff: newName.length - name.length,
                                        span: r.textSpan
                                    });
                                });
                            }
                        }
                        else {
                            takenNames[name] = true;
                        }
                    }
                    checkChildren(child);
                });
            }

            return takenNames
        }
    }

    export function getNewName(name: string, takenNames: NamesSet, recordNewName = true) {
        // If the variable is a single lower case letter, try and rename it to a different letter (i.e. i -> j)
        // DO NOT apply this logic to variables named x, y, or z since those are generally meaningful names
        if (name.length === 1 && name !== "x" && name !== "y" && name !== "z") {
            const charCode = name.charCodeAt(0);
            if (charCode >= lowerCaseAlphabetStartCode && charCode <= lowerCaseAlphabetEndCode) {
                const offset = charCode - lowerCaseAlphabetStartCode;
                for (let i = 1; i < 26; i++) {
                    const newChar = String.fromCharCode(lowerCaseAlphabetStartCode + ((offset + i) % 26));
                    if (newChar === "x" || newChar === "y" || newChar === "z") continue;
                    if (!takenNames[newChar]) {
                        if (recordNewName)
                            takenNames[newChar] = true;
                        return newChar;
                    }
                }
            }
        }

        // For all other names, add a number to the end. Start at 2 because it probably makes more sense for kids
        for (let i = 2; ; i++) {
            const toTest = name + i;
            if (!takenNames[toTest]) {
                if (recordNewName)
                    takenNames[toTest] = true;
                return toTest;
            }
        }
    }

    export interface DecompileBlocksOptions {
        snippetMode?: boolean; // do not emit "on start"
        alwaysEmitOnStart?: boolean; // emit "on start" even if empty
        errorOnGreyBlocks?: boolean; // fail on grey blocks (usefull when testing docs)
        allowedArgumentTypes?: string[]; // a whitelist of types that can be decompiled for user defined function arguments
        generateSourceMap?: boolean; // generate block ids
        /*@internal*/
        includeGreyBlockMessages?: boolean; // adds error attributes to the mutations in typescript_statement blocks (for debug pruposes)
    }

    enum ReferenceType {
        // Variable is never referenced
        None = 0,
        // Variable is only referenced in "non-grey" blocks
        InBlocksOnly = 1,
        // Variable is referenced at least once inside "grey" blocks
        InTextBlocks = 2
    }

    export function decompileToBlocks(blocksInfo: pxtc.BlocksInfo, file: ts.SourceFile, options: DecompileBlocksOptions, renameMap?: RenameMap): pxtc.CompileResult {
        let emittedBlocks = 0;
        let stmts: NodeArray<ts.Statement> = file.statements;
        const result: pxtc.CompileResult = {
            blocksInfo: blocksInfo,
            outfiles: {},
            diagnostics: [],
            success: true,
            times: {}
        }
        if (options.generateSourceMap)
            result.blockSourceMap = [];
        const env: DecompilerEnv = {
            blocks: blocksInfo,
            declaredFunctions: {},
            declaredEnums: {},
            declaredKinds: {},
            functionParamIds: {},
            attrs: attrs,
            compInfo: compInfo,
            localReporters: [],
            tileset: [],
            opts: options || {},
            aliasBlocks: {}
        };
        const fileText = file.getFullText();
        let output = ""

        const enumMembers: BlocklyVariableDeclaration[] = [];
        const varUsages: pxt.Map<ReferenceType> = {};
        const workspaceComments: WorkspaceComment[] = [];
        const autoDeclarations: [string, ts.Node][] = [];

        const getCommentRef = (() => { let currentCommentId = 0; return () => `${currentCommentId++}` })();

        const apis = blocksInfo.apis.byQName;
        Object.keys(apis).forEach(qName => {
            const api = apis[qName];
            if (api.attributes.blockAliasFor && apis[api.attributes.blockAliasFor]) {
                env.aliasBlocks[api.attributes.blockAliasFor] = api.qName;
            }
        });


        const commentMap = buildCommentMap(file);

        const checkTopNode = (topLevelNode: Node) => {
            if (topLevelNode.kind === SK.FunctionDeclaration && !checkStatement(topLevelNode, env, false, true)) {
                env.declaredFunctions[getVariableName((topLevelNode as ts.FunctionDeclaration).name)] = topLevelNode as ts.FunctionDeclaration;
            }
            else if (topLevelNode.kind === SK.EnumDeclaration && !checkStatement(topLevelNode, env, false, true)) {
                const enumName = (topLevelNode as EnumDeclaration).name.text;
                env.declaredEnums[enumName] = true;
                getEnumMembers(topLevelNode as EnumDeclaration).forEach(([name, value]) => {
                    // We add the value to the front of the name because it needs to be maintained
                    // across compilation/decompilation just in case the code relies on the actual value.
                    // It's safe to do because enum members can't start with numbers.
                    enumMembers.push({
                        name: value + name,
                        type: enumName
                    });
                });
            }
            else if (isModuleDeclaration(topLevelNode)) {
                if (!checkKindNamespaceDeclaration(topLevelNode as ts.NamespaceDeclaration, env)) {
                    const kindName = topLevelNode.name.text;
                    const exported = getModuleExports(topLevelNode);

                    if (env.declaredKinds[kindName]) {
                        env.declaredKinds[kindName].declaredNames.push(...(exported.map(({ name }) => name)));
                    }
                }
                else if (!checkTilesetNamespace(topLevelNode as ts.NamespaceDeclaration)) {
                    env.tileset = getModuleExports(topLevelNode).map(({ name, initializer }) => ({
                        projectId: parseInt(name.substr(pxt.sprite.TILE_PREFIX.length)),
                        data: pxt.sprite.imageLiteralToBitmap(initializer).data()
                    }));
                }
            }
            else if (topLevelNode.kind === SK.Block) {
                ts.forEachChild(topLevelNode, checkTopNode);
            }
        };

        Object.keys(blocksInfo.kindsByName).forEach(k => {
            const kindInfo = blocksInfo.kindsByName[k];
            env.declaredKinds[k] = { kindInfo, declaredNames: [] };
        });

        ts.forEachChild(file, checkTopNode);

        // Generate fresh param IDs for all user-declared functions, needed when decompiling
        // function definition and calls. IDs don't need to be crypto secure.
        const genId = () => (Math.PI * Math.random()).toString(36).slice(2);
        Object.keys(env.declaredFunctions).forEach(funcName => {
            env.functionParamIds[funcName] = {};
            env.declaredFunctions[funcName].parameters.forEach(p => {
                env.functionParamIds[funcName][p.name.getText()] = genId() + genId();
            });
        });

        Object.keys(env.declaredKinds).forEach(kindName => {
            const kindType = "KIND_" + kindName;
            env.declaredKinds[kindName].declaredNames.forEach(kindMember => enumMembers.push({
                name: kindMember,
                type: kindType
            }));
        });

        if (enumMembers.length || env.tileset.length) {
            write("<variables>")
            enumMembers.forEach(e => {
                write(`<variable type="${U.htmlEscape(e.type)}">${U.htmlEscape(e.name)}</variable>`)
            });
            env.tileset.forEach(e => {
                write(`<variable type="${pxt.sprite.BLOCKLY_TILESET_TYPE}">${pxt.sprite.legacy.tileToBlocklyVariable(e)}</variable>`)
            });
            write("</variables>")
        }

        let n: StatementNode;
        try {
            n = codeBlock(stmts, undefined, true, undefined, !options.snippetMode);

            // Emit all of the orphaned comments
            for (const comment of commentMap) {
                if (!comment.owner) {
                    workspaceComments.push({
                        refId: getCommentRef(),
                        comment: [comment]
                    });
                }
            }
        }
        catch (e) {
            if ((<any>e).programTooLarge) {
                result.success = false;
                result.diagnostics = pxtc.patchUpDiagnostics([{
                    file,
                    start: file.getFullStart(),
                    length: file.getFullWidth(),
                    messageText: e.message,
                    category: ts.DiagnosticCategory.Error,
                    code: FILE_TOO_LARGE_CODE
                }]);
            }
            else {
                // don't throw
                pxt.reportException(e);
                result.success = false;
                result.diagnostics = pxtc.patchUpDiagnostics([{
                    file,
                    start: file.getFullStart(),
                    length: file.getFullWidth(),
                    messageText: e.message,
                    category: ts.DiagnosticCategory.Error,
                    code: DECOMPILER_ERROR
                }]);
                return result;
            }
        }

        if (n) {
            emitStatementNode(n);
        } else if (!options.snippetMode && !stmts.length) {
            openBlockTag(ts.pxtc.ON_START_TYPE, mkStmt(ts.pxtc.ON_START_TYPE, stmts[0]));
            closeBlockTag();
        }

        workspaceComments.forEach(c => {
            emitWorkspaceComment(c);
        })

        result.outfiles[file.fileName.replace(/(\.blocks)?\.\w*$/i, '') + '.blocks'] = `<xml xmlns="http://www.w3.org/1999/xhtml">
${output}</xml>`;

        return result;

        function write(s: string, suffix = "\n") {
            output += s + suffix
        }

        function error(n: ts.Node, msg?: string) {
            const messageText = msg || `Language feature "${n.getFullText().trim()}"" not supported in blocks`;
            const diags = pxtc.patchUpDiagnostics([{
                file: file,
                start: n.getFullStart(),
                length: n.getFullWidth(),
                messageText,
                category: ts.DiagnosticCategory.Error,
                code: 1001
            }])
            pxt.debug(`decompilation error: ${messageText}`)
            U.pushRange(result.diagnostics, diags)
            result.success = false;
        }

        function attrs(callInfo: DecompilerCallInfo): pxtc.CommentAttrs {
            const blockInfo = blocksInfo.apis.byQName[callInfo.decompilerBlockAlias || callInfo.qName];
            if (blockInfo) {
                const attributes = blockInfo.attributes;

                // Check to make sure this block wasn't filtered out (bannedCategories)
                if (!attributes.blockId || blocksInfo.blocksById[attributes.blockId] || attributes.blockId === pxtc.PAUSE_UNTIL_TYPE) {
                    return blockInfo.attributes;
                }
            }
            else if (callInfo.decl) {
                const parsed = parseComments(callInfo.decl);
                if (parsed) return parsed;
            }
            return {
                paramDefl: {},
                callingConvention: ir.CallingConvention.Plain
            };
        }

        function compInfo(callInfo: pxtc.CallInfo): pxt.blocks.BlockCompileInfo {
            const blockInfo = blocksInfo.apis.byQName[callInfo.qName];
            if (blockInfo) {
                return pxt.blocks.compileInfo(blockInfo);
            }
            return undefined;
        }

        function countBlock() {
            emittedBlocks++;
            if (emittedBlocks > MAX_BLOCKS) {
                let e = new Error(Util.lf("Could not decompile because the script is too large"));
                (<any>e).programTooLarge = true;
                throw e
            }
        }

        // generated ids with the same entropy as blockly
        function blocklyGenUid() {
            const soup_ = '!#$%()*+,-./:;=?@[]^_`{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            const length = 20;
            const soupLength = soup_.length;
            const id = [];
            for (let i = 0; i < length; i++) {
                id[i] = soup_.charAt(Math.random() * soupLength);
            }
            return id.join('');
        }

        function mkId(type: string, node: ts.Node): string {
            if (type == ts.pxtc.ON_START_TYPE)
                return "xRRgvHNlG#rZ^u`HECiY";
            const id = blocklyGenUid()
            if (node) {
                const startPos = node.getFullStart();
                result.blockSourceMap.push(<pxt.blocks.BlockSourceInterval>{
                    id,
                    startPos,
                    endPos: startPos + node.getFullWidth()
                })
            }
            return id;
        }

        function mkStmt(type: string, node: ts.Node): StatementNode {
            const stm: StatementNode = {
                kind: "statement",
                type
            };
            if (result.blockSourceMap)
                stm.id = mkId(type, node);
            return stm;
        }

        function mkExpr(type: string, node: ts.Node): ExpressionNode {
            const expr: ExpressionNode = {
                kind: "expr",
                type
            };
            //if (result.blockSourceMap)
            //    expr.id = mkId(type, node);
            return expr;
        }

        function mkValue(name: string, value: ExpressionNode | TextNode, shadowType?: string, shadowMutation?: pxt.Map<string>): ValueNode {
            if ((!shadowType || shadowType === numberType) && shadowMutation && shadowMutation['min'] && shadowMutation['max']) {
                // Convert a number to a number with a slider (math_number_minmax) if min and max shadow options are defined
                shadowType = minmaxNumberType;
            }

            return { kind: "value", name, value, shadowType, shadowMutation };
        }

        function isEventExpression(expr: ts.ExpressionStatement): boolean {
            if (expr.expression.kind == SK.CallExpression) {
                const call = expr.expression as ts.CallExpression;
                const callInfo = pxtInfo(call).callInfo;
                if (!callInfo) {
                    error(expr)
                    return false;
                }
                const attributes = attrs(callInfo);
                return attributes.blockId && !attributes.handlerStatement && !callInfo.isExpression && hasStatementInput(callInfo, attributes);
            }
            return false;
        }

        function emitStatementNode(n: StatementNode) {
            if (!n) {
                return;
            }

            openBlockTag(n.type, n)
            emitBlockNodeCore(n);

            if (n.data !== undefined) {
                write(`<data>${U.htmlEscape(n.data)}</data>`)
            }

            if (n.handlers) {
                n.handlers.forEach(emitHandler);
            }

            if (n.next) {
                write("<next>")
                emitStatementNode(n.next);
                write("</next>")
            }

            if (n.comment !== undefined) {
                write(`<comment pinned="false">${U.htmlEscape(formatCommentsForBlocks(n.comment))}</comment>`)
            }

            closeBlockTag();
        }

        function emitMutation(mMap: pxt.Map<string>, mChildren?: MutationChild[]) {
            write("<mutation ", "");
            Object.keys(mMap).forEach(key => {
                if (mMap[key] !== undefined) {
                    write(`${key}="${mMap[key]}" `, "");
                }
            });
            if (mChildren) {
                write(">");
                mChildren.forEach(c => {
                    write(`<${c.nodeName} `, "");
                    Object.keys(c.attributes).forEach(attrName => {
                        write(`${attrName}="${U.htmlEscape(c.attributes[attrName])}" `, "");
                    });
                    write("/>");
                });
                write("</mutation>");
            } else {
                write("/>");
            }
        }

        function emitBlockNodeCore(n: BlockNode) {
            if (n.mutation) {
                emitMutation(n.mutation, n.mutationChildren);
            }

            if (n.fields) {
                n.fields.forEach(emitFieldNode)
            }

            if (n.inputs) {
                n.inputs.forEach(emitValueNode);
            }
        }

        function emitValueNode(n: ValueNode) {
            write(`<value name="${n.name}">`)

            let emitShadowOnly = false;

            if (n.value.kind === "expr") {
                const value = n.value as ExpressionNode;
                if (value.type === numberType && n.shadowType === minmaxNumberType) {
                    value.type = minmaxNumberType;
                    value.fields[0].name = 'SLIDER';
                    value.mutation = n.shadowMutation;
                }
                emitShadowOnly = value.type === n.shadowType;
                if (!emitShadowOnly) {
                    switch (value.type) {
                        case "math_number":
                        case "math_number_minmax":
                        case "math_integer":
                        case "math_whole_number":
                        case "logic_boolean":
                        case "text":
                            emitShadowOnly = !n.shadowType;
                            break
                    }
                }
            }

            if (emitShadowOnly) {
                emitOutputNode(n.value, true);
            }
            else {
                // Emit a shadow block to appear if the given input is removed
                if (n.shadowType !== undefined) {
                    switch (n.shadowType) {
                        case numberType:
                        case integerNumberType:
                        case wholeNumberType:
                            write(`<shadow type="${n.shadowType}"><field name="NUM">0</field></shadow>`)
                            break;
                        case minmaxNumberType:
                            write(`<shadow type="${minmaxNumberType}">`);
                            if (n.shadowMutation) {
                                emitMutation(n.shadowMutation);
                            }
                            write(`<field name="SLIDER">0</field></shadow>`);
                            break;
                        case booleanType:
                            write(`<shadow type="${booleanType}"><field name="BOOL">TRUE</field></shadow>`)
                            break;
                        case stringType:
                            write(`<shadow type="${stringType}"><field name="TEXT"></field></shadow>`)
                            break;
                        default:
                            write(`<shadow type="${n.shadowType}"/>`)
                    }
                }
                emitOutputNode(n.value);
            }

            write(`</value>`)
        }

        function emitFieldNode(n: FieldNode) {
            write(`<field name="${U.htmlEscape(n.name)}">${U.htmlEscape(n.value.toString())}</field>`);
        }

        function emitHandler(h: Handler) {
            write(`<statement name="${U.htmlEscape(h.name)}">`)
            emitStatementNode(h.statement);
            write(`</statement>`)
        }

        function emitOutputNode(n: OutputNode, shadow = false) {
            if (n.kind === "text") {
                const node = n as TextNode;
                write(node.value);
            }
            else {
                const node = n as ExpressionNode;
                const isShadow = shadow || node.isShadow;
                const tag = isShadow ? "shadow" : "block";
                if (!isShadow) {
                    countBlock();
                }

                write(`<${tag} ${node.id ? `id="${node.id}" ` : ''}type="${U.htmlEscape(node.type)}">`)
                emitBlockNodeCore(node);
                write(`</${tag}>`)
            }
        }

        function openBlockTag(type: string, node: StatementNode) {
            countBlock();
            const id = node && node.id;
            write(`<block ${id ? `id="${node.id}" ` : ''}type="${U.htmlEscape(type)}">`)
        }

        function closeBlockTag() {
            write(`</block>`)
        }

        function emitWorkspaceComment(comment: WorkspaceComment) {
            let maxLineLength = 0;
            const text = formatCommentsForBlocks(comment.comment);
            if (text.trim()) {
                const lines = text.split("\n");
                lines.forEach(line => maxLineLength = Math.max(maxLineLength, line.length));

                // These are just approximations but they are the best we can do outside the DOM
                const width = Math.max(Math.min(maxLineLength * 10, maxCommentWidth), minCommentWidth);
                const height = Math.max(Math.min(lines.length * 40, maxCommentHeight), minCommentHeight);

                write(`<comment h="${height}" w="${width}" data="${U.htmlEscape(comment.refId)}">`)
                write(U.htmlEscape(text))
                write(`</comment>`);
            }
        }

        function getOutputBlock(n: ts.Node): OutputNode {
            if (checkExpression(n, env)) {
                return getTypeScriptExpressionBlock(n);
            }
            else {
                switch (n.kind) {
                    case SK.ExpressionStatement:
                        return getOutputBlock((n as ts.ExpressionStatement).expression);
                    case SK.ParenthesizedExpression:
                        return getOutputBlock((n as ts.ParenthesizedExpression).expression);
                    case SK.Identifier:
                        return getIdentifier(n as ts.Identifier);
                    case SK.StringLiteral:
                    case SK.FirstTemplateToken:
                    case SK.NoSubstitutionTemplateLiteral:
                        return getStringLiteral((n as ts.LiteralExpression).text);
                    case SK.NumericLiteral:
                        return getNumericLiteral((n as ts.LiteralExpression).text);
                    case SK.TrueKeyword:
                        return getBooleanLiteral(true);
                    case SK.FalseKeyword:
                        return getBooleanLiteral(false);
                    case SK.BinaryExpression:
                        return getBinaryExpression(n as ts.BinaryExpression);
                    case SK.PrefixUnaryExpression:
                        return getPrefixUnaryExpression(n as ts.PrefixUnaryExpression);
                    case SK.PropertyAccessExpression:
                        return getPropertyAccessExpression(n as ts.PropertyAccessExpression);
                    case SK.ArrayLiteralExpression:
                        return getArrayLiteralExpression(n as ts.ArrayLiteralExpression);
                    case SK.ElementAccessExpression:
                        return getElementAccessExpression(n as ts.ElementAccessExpression);
                    case SK.TaggedTemplateExpression:
                        return getTaggedTemplateExpression(n as ts.TaggedTemplateExpression);
                    case SK.CallExpression:
                        return getStatementBlock(n, undefined, undefined, true) as any;
                    default:
                        error(n, Util.lf("Unsupported syntax kind for output expression block: {0}", SK[n.kind]));
                        break;
                }
                return undefined;
            }
        }

        function applyRenamesInRange(text: string, start: number, end: number) {
            if (renameMap) {
                const renames = renameMap.getRenamesInSpan(start, end);

                if (renames.length) {
                    let offset = 0;

                    renames.forEach(rename => {
                        const sIndex = rename.span.start + offset - start;
                        const eIndex = sIndex + rename.span.length;

                        offset += rename.diff;

                        text = text.slice(0, sIndex) + rename.name + text.slice(eIndex);
                    });
                }
            }

            return text;
        }

        function getTypeScriptExpressionBlock(n: ts.Node) {
            const text = applyRenamesInRange(n.getFullText(), n.getFullStart(), n.getEnd()).trim();
            trackVariableUsagesInText(n);

            // Mark comments or else they are emitted twice
            markCommentsInRange(n, commentMap);

            return getFieldBlock(pxtc.TS_OUTPUT_TYPE, "EXPRESSION", text);
        }

        function getBinaryExpression(n: ts.BinaryExpression): ExpressionNode {
            const op = n.operatorToken.getText();
            const npp = ops[op];

            // Could be string concatenation
            if (isTextJoin(n)) {
                return getTextJoin(n);
            }

            const leftName = npp.leftName || "A";
            const rightName = npp.rightName || "B";

            let leftValue: ValueNode;
            let rightValue: ValueNode;

            if (op === "&&" || op === "||") {
                leftValue = getConditionalInput(leftName, n.left);
                rightValue = getConditionalInput(rightName, n.right);
            } else {
                leftValue = getValue(leftName, n.left, numberType);
                rightValue = getValue(rightName, n.right, numberType);
            }

            const r = mkExpr(npp.type, n);
            r.fields = [];

            if (npp.op) {
                r.fields.push(getField("OP", npp.op))
            }

            r.inputs = [leftValue, rightValue];

            return r;

        }

        function isTextJoin(n: ts.Node): boolean {
            if (n.kind === SK.BinaryExpression) {
                const b = n as ts.BinaryExpression;
                if (b.operatorToken.getText() === "+" || b.operatorToken.kind == SK.PlusEqualsToken) {
                    const info: BinaryExpressionInfo = pxtInfo(n).exprInfo;
                    return !!info;
                }
            }

            return false;
        }

        function collectTextJoinArgs(n: ts.Node, result: ts.Node[]) {
            if (isTextJoin(n)) {
                collectTextJoinArgs((n as ts.BinaryExpression).left, result);
                collectTextJoinArgs((n as ts.BinaryExpression).right, result);
            }
            else {
                result.push(n);
            }
        }

        function getTextJoin(n: ts.Node) {
            const args: ts.Node[] = [];
            collectTextJoinArgs(n, args);

            const inputs: ValueNode[] = [];
            for (let i = 0; i < args.length; i++) {
                if (i > 0 || !isEmptyString(args[i].getText())) {
                    inputs.push(getValue("ADD" + inputs.length, args[i], stringType));
                }
            }

            const r = mkExpr("text_join", n);
            r.inputs = inputs;
            r.mutation = {
                "items": inputs.length.toString()
            };
            return r;
        }

        function getValue(name: string, contents: boolean | number | string | Node, shadowType?: string, shadowMutation?: pxt.Map<string>): ValueNode {
            let value: OutputNode;

            if (typeof contents === "number") {
                value = getNumericLiteral(contents.toString())
            }
            else if (typeof contents === "boolean") {
                value = getBooleanLiteral(contents)
            }
            else if (typeof contents === "string") {
                value = getStringLiteral(contents)
            }
            else {
                value = getOutputBlock(contents)
            }
            if (value.kind == "expr" && (value as ExpressionNode).type == "math_number") {
                const actualValue = value.fields[0].value as number;
                if (shadowType == "math_integer" && actualValue % 1 === 0)
                    (value as ExpressionNode).type = "math_integer";
                if (shadowType == "math_whole_number" && actualValue % 1 === 0 && actualValue > 0)
                    (value as ExpressionNode).type = "math_whole_number";
            }

            return mkValue(name, value, shadowType, shadowMutation);
        }

        function getIdentifier(identifier: Identifier): ExpressionNode {
            if (isDeclaredElsewhere(identifier)) {
                const info = pxtInfo(identifier);

                const id = blocksInfo.apis.byQName[info.commentAttrs.blockIdentity];
                return getEnumFieldBlock(id, info.commentAttrs.enumIdentity);
            }
            const name = getVariableName(identifier);
            const oldName = identifier.text;
            let localReporterArg: PropertyDesc = null;
            env.localReporters.some(scope => {
                for (let i = 0; i < scope.length; ++i) {
                    if (scope[i].name === oldName) {
                        localReporterArg = scope[i];
                        return true;
                    }
                }
                return false;
            });

            if (localReporterArg) {
                return getDraggableReporterBlock(name, localReporterArg.type, false);
            } else {
                trackVariableUsage(name, ReferenceType.InBlocksOnly);
                return getFieldBlock("variables_get", "VAR", name);
            }
        }

        function getNumericLiteral(value: string): ExpressionNode {
            return getFieldBlock("math_number", "NUM", value);
        }

        function getStringLiteral(value: string): ExpressionNode {
            return getFieldBlock("text", "TEXT", value);
        }

        function getBooleanLiteral(value: boolean): ExpressionNode {
            return getFieldBlock("logic_boolean", "BOOL", value ? "TRUE" : "FALSE");
        }

        function getFieldBlock(type: string, fieldName: string, value: string, isShadow?: boolean): ExpressionNode {
            const r = mkExpr(type, null);
            r.fields = [getField(fieldName, value)];
            r.isShadow = isShadow;
            return r;
        }

        function getDraggableVariableBlock(valueName: string, varName: string) {
            return mkValue(valueName,
                getFieldBlock("variables_get_reporter", "VAR", varName, true), "variables_get_reporter");
        }

        function mkDraggableReporterValue(valueName: string, varName: string, varType: string) {
            const reporterType = pxt.blocks.reporterTypeForArgType(varType);
            const reporterShadowBlock = getDraggableReporterBlock(varName, varType, true);
            return mkValue(valueName, reporterShadowBlock, reporterType);
        }

        function getDraggableReporterBlock(varName: string, varType: string, shadow: boolean) {
            const reporterType = pxt.blocks.reporterTypeForArgType(varType);
            const reporterShadowBlock = getFieldBlock(reporterType, "VALUE", varName, shadow);

            if (reporterType === "argument_reporter_custom") {
                reporterShadowBlock.mutation = { typename: varType };
            }

            return reporterShadowBlock;
        }

        function getField(name: string, value: string): FieldNode {
            return {
                kind: "field",
                name,
                value,
            };
        }

        // TODO: Add a real negation block
        function negateNumericNode(node: ts.Node): ExpressionNode {
            const r = mkExpr("math_arithmetic", node);
            r.inputs = [
                getValue("A", 0, numberType),
                getValue("B", node, numberType)
            ];
            r.fields = [getField("OP", "MINUS")];
            return r;
        }

        function getPrefixUnaryExpression(node: PrefixUnaryExpression): OutputNode {
            switch (node.operator) {
                case SK.ExclamationToken:
                    const r = mkExpr("logic_negate", node);
                    r.inputs = [getConditionalInput("BOOL", node.operand)];
                    return r;
                case SK.PlusToken:
                    return getOutputBlock(node.operand);
                case SK.MinusToken:
                    if (node.operand.kind == SK.NumericLiteral) {
                        return getNumericLiteral("-" + (node.operand as ts.LiteralExpression).text)
                    } else {
                        return negateNumericNode(node.operand)
                    }
                default:
                    error(node);
                    break;
            }
            return undefined;
        }

        function getPropertyAccessExpression(n: ts.PropertyAccessExpression, asField = false, blockId?: string): OutputNode {
            let callInfo = pxtInfo(n).callInfo;
            if (!callInfo) {
                error(n);
                return undefined;
            }

            if (n.expression.kind === SK.Identifier) {
                const enumName = (n.expression as ts.Identifier).text;
                if (env.declaredEnums[enumName]) {
                    const enumInfo = blocksInfo.enumsByName[enumName];
                    if (enumInfo && enumInfo.blockId) {
                        return getFieldBlock(enumInfo.blockId, "MEMBER", n.name.text);
                    }
                }
                else if (env.declaredKinds[enumName]) {
                    const info = env.declaredKinds[enumName];
                    return getFieldBlock(info.kindInfo.blockId, "MEMBER", n.name.text);
                }
            }

            const attributes = attrs(callInfo);
            blockId = attributes.blockId || blockId;

            if (attributes.blockCombine)
                return getPropertyGetBlock(n, n)

            if (attributes.blockId === "lists_length" || attributes.blockId === "text_length") {
                const r = mkExpr(U.htmlEscape(attributes.blockId), n);
                r.inputs = [getValue("VALUE", n.expression)];

                return r;
            }

            let value = U.htmlEscape(attributes.blockId || callInfo.qName);

            const [parent,] = getParent(n);
            const parentCallInfo: pxtc.CallInfo = parent && pxtInfo(parent).callInfo;
            if (asField || !(blockId || attributes.blockIdentity) || parentCallInfo && parentCallInfo.qName === attributes.blockIdentity) {
                return {
                    kind: "text",
                    value
                }
            }

            if (attributes.enumval && parentCallInfo && attributes.useEnumVal) {
                value = attributes.enumval;
            }

            const info = env.compInfo(callInfo);

            if (blockId && info && info.thisParameter) {
                const r = mkExpr(blockId, n);
                r.inputs = [getValue(U.htmlEscape(info.thisParameter.definitionName), n.expression, info.thisParameter.shadowBlockId)];
                return r;
            }

            let idfn = attributes.blockIdentity ? blocksInfo.apis.byQName[attributes.blockIdentity] : blocksInfo.blocksById[blockId];
            return getEnumFieldBlock(idfn, value);
        }

        function getEnumFieldBlock(idfn: SymbolInfo, value: string) {
            let f = /(?:%|\$)([a-zA-Z0-9_]+)/.exec(idfn.attributes.block);
            const r = mkExpr(U.htmlEscape(idfn.attributes.blockId), undefined);
            r.fields = [{
                kind: "field",
                name: U.htmlEscape(f[1]),
                value
            }];
            return r;
        }

        function getArrayLiteralExpression(n: ts.ArrayLiteralExpression): ExpressionNode {
            const r = mkExpr("lists_create_with", n);
            r.inputs = n.elements.map((e, i) => getValue("ADD" + i, e));
            r.mutation = {
                "items": n.elements.length.toString()
            };
            return r;
        }

        function getElementAccessExpression(n: ts.ElementAccessExpression): ExpressionNode {
            const r = mkExpr("lists_index_get", n);
            r.inputs = [getValue("LIST", n.expression), getValue("INDEX", n.argumentExpression, numberType)]
            return r;
        }

        function getTaggedTemplateExpression(t: ts.TaggedTemplateExpression): ExpressionNode {
            const callInfo: pxtc.CallInfo = pxtInfo(t).callInfo;

            let api: SymbolInfo;
            const paramInfo = getParentParameterInfo(t);
            if (paramInfo && paramInfo.shadowBlockId) {
                const shadow = env.blocks.blocksById[paramInfo.shadowBlockId];
                if (shadow && shadow.attributes.shim === "TD_ID") {
                    api = shadow;
                }
            }
            if (!api) {
                api = env.blocks.apis.byQName[attrs(callInfo).blockIdentity];
            }

            const comp = pxt.blocks.compileInfo(api);

            const r = mkExpr(api.attributes.blockId, t);

            let text: string;
            const param = comp.parameters[0];

            if (param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileArgumentAsString]) {
                text = t.getText();
            }
            else {
                text = (t.template as ts.NoSubstitutionTemplateLiteral).text;
            }

            // This will always be a field and not a value because we only allow no-substitution templates
            r.fields = [getField(param.actualName, text)];

            return r;
        }

        function getParentParameterInfo(n: ts.Expression) {
            if (n.parent && n.parent.kind === SK.CallExpression) {
                const call = n.parent as CallExpression;
                const info = pxtInfo(call).callInfo;
                const index = call.arguments.indexOf(n);
                if (info && index !== -1) {
                    const blockInfo = blocksInfo.apis.byQName[info.qName];
                    if (blockInfo) {
                        const comp = pxt.blocks.compileInfo(blockInfo);
                        return comp && comp.parameters[index];
                    }
                }
            }
            return undefined;
        }

        function getStatementBlock(n: ts.Node, next?: ts.Node[], parent?: ts.Node, asExpression = false, topLevel = false): StatementNode {
            const node = n as ts.Node;
            let stmt: StatementNode;
            let skipComments = false;

            const err = checkStatement(node, env, asExpression, topLevel);
            if (err) {
                stmt = getTypeScriptStatementBlock(node, undefined, err);
            }
            else {
                switch (node.kind) {
                    case SK.Block:
                        let bBlock = codeBlock((node as ts.Block).statements, next, topLevel);

                        return bBlock;
                    case SK.ExpressionStatement:
                        return getStatementBlock((node as ts.ExpressionStatement).expression, next, parent || node, asExpression, topLevel);
                    case SK.VariableStatement:
                        stmt = codeBlock((node as ts.VariableStatement).declarationList.declarations, undefined, false, parent || node);
                        if (!stmt) return getNext();
                        // Comments are already gathered by the call to code block
                        skipComments = true;
                        break;
                    case SK.FunctionExpression:
                    case SK.ArrowFunction:
                        return getArrowFunctionStatement(node as ts.ArrowFunction, next);
                    case SK.BinaryExpression:
                        stmt = getBinaryExpressionStatement(node as ts.BinaryExpression);
                        break;
                    case SK.PostfixUnaryExpression:
                    case SK.PrefixUnaryExpression:
                        stmt = getIncrementStatement(node as (ts.PrefixUnaryExpression | ts.PostfixUnaryExpression));
                        break;
                    case SK.VariableDeclaration:
                        const decl = node as ts.VariableDeclaration;
                        if (isAutoDeclaration(decl)) {
                            // Don't emit null or automatic initializers;
                            // They are implicit within the blocks. But do track them in case they
                            // never get used in the blocks (and thus won't be emitted again)

                            trackAutoDeclaration(decl);
                            return getNext();
                        }
                        stmt = getVariableDeclarationStatement(node as ts.VariableDeclaration);
                        break;
                    case SK.WhileStatement:
                        stmt = getWhileStatement(node as ts.WhileStatement);
                        break;
                    case SK.IfStatement:
                        stmt = getIfStatement(node as ts.IfStatement);
                        break;
                    case SK.ForStatement:
                        stmt = getForStatement(node as ts.ForStatement);
                        break;
                    case SK.ForOfStatement:
                        stmt = getForOfStatement(node as ts.ForOfStatement);
                        break;
                    case SK.FunctionDeclaration:
                        stmt = getFunctionDeclaration(node as ts.FunctionDeclaration);
                        break;
                    case SK.CallExpression:
                        stmt = getCallStatement(node as ts.CallExpression, asExpression) as StatementNode;
                        break;
                    case SK.DebuggerStatement:
                        stmt = getDebuggerStatementBlock(node);
                        break;
                    case SK.BreakStatement:
                        stmt = getBreakStatementBlock(node);
                        break;
                    case SK.ContinueStatement:
                        stmt = getContinueStatementBlock(node);
                        break;
                    case SK.EmptyStatement:
                        stmt = undefined; // don't generate blocks for empty statements
                        break;
                    case SK.EnumDeclaration:
                    case SK.ModuleDeclaration:
                        // If the enum declaration made it past the checker then it is emitted elsewhere
                        markCommentsInRange(node, commentMap);
                        return getNext();
                    case SK.ReturnStatement:
                        stmt = getReturnStatementBlock(node as ts.ReturnStatement);
                        break;
                    default:
                        if (next) {
                            error(node, Util.lf("Unsupported statement in block: {0}", SK[node.kind]))
                        }
                        else {
                            error(node, Util.lf("Statement kind unsupported in blocks: {0}", SK[node.kind]))
                        }
                        return undefined;
                }
            }

            if (stmt) {
                let end = stmt;
                while (end.next) {
                    end = end.next;
                }
                end.next = getNext();
                if (end.next) {
                    end.next.prev = end;
                }
            }

            if (!skipComments) {
                getComments(parent || node);
            }

            return stmt;

            function getNext() {
                if (next && next.length) {
                    return getStatementBlock(next.shift(), next, undefined, false, topLevel);
                }
                return undefined;
            }

            /**
             * We split up comments according to the following rules:
             *      1. If the comment is not top-level:
             *          a. Combine it with all comments for the following statement
             *          b. If there is no following statement in the current block, group it with the previous statement
             *          c. If there are no statements inside the block, group it with the parent block
             *          d. If trailing the same line as the statement, group it with the comments for that statement
             *      2. If the comment is top-level:
             *          b. If the comment is followed by an empty line, it becomes a workspace comment
             *          c. If the comment is followed by a multi-line comment, it becomes a workspace comment
             *          a. If the comment is a single-line comment, combine it with the next single-line comment
             *          d. If the comment is not followed with an empty line, group it with the next statement or event
             *          e. All other comments are workspace comments
             */

            function getComments(commented: Node) {
                let comments: Comment[] = [];
                let current: Comment;
                for (let i = 0; i < commentMap.length; i++) {
                    current = commentMap[i];
                    if (!current.owner && current.start >= commented.pos && current.end <= commented.end) {
                        current.owner = commented;
                        current.ownerStatement = stmt;
                        comments.push(current);
                    }

                    if (current.start > commented.end) break;
                }

                if (current && current.isTrailingComment) {
                    const endLine = ts.getLineAndCharacterOfPosition(file, commented.end);
                    const commentLine = ts.getLineAndCharacterOfPosition(file, current.start);

                    if (endLine.line === commentLine.line) {
                        // If the comment is trailing and on the same line as the statement, it probably belongs
                        // to this statement. Remove it from any statement it's already assigned to and any workspace
                        // comments
                        if (current.ownerStatement) {
                            current.ownerStatement.comment.splice(current.ownerStatement.comment.indexOf(current), 1);

                            for (const wsComment of workspaceComments) {
                                wsComment.comment.splice(wsComment.comment.indexOf(current), 1)
                            }
                        }
                        current.owner = commented;
                        current.ownerStatement = stmt;
                        comments.push(current);
                    }
                }

                if (comments.length) {
                    const wsCommentRefs: string[] = [];

                    if (isTopLevelComment(commented)) {
                        let currentWorkspaceComment: Comment[] = [];

                        const localWorkspaceComments: Comment[][] = [];

                        comments.forEach((comment, index) => {
                            let beforeStatement = comment.owner && comment.start < comment.owner.getStart();
                            if (comment.kind === CommentKind.MultiLine && beforeStatement) {
                                if (currentWorkspaceComment.length) {
                                    localWorkspaceComments.push(currentWorkspaceComment);
                                    currentWorkspaceComment = [];
                                }
                                if (index != comments.length - 1) {
                                    localWorkspaceComments.push([comment]);
                                    return;
                                }
                            }

                            currentWorkspaceComment.push(comment);

                            if (comment.followedByEmptyLine && beforeStatement) {
                                localWorkspaceComments.push(currentWorkspaceComment);
                                currentWorkspaceComment = [];
                            }
                        });

                        comments = currentWorkspaceComment;

                        localWorkspaceComments.forEach(comment => {
                            const refId = getCommentRef();

                            wsCommentRefs.push(refId);
                            workspaceComments.push({ comment, refId });
                        });
                    }

                    if (stmt) {
                        if (wsCommentRefs.length) {
                            if (stmt.data) stmt.data += ";" + wsCommentRefs.join(";")
                            else stmt.data = wsCommentRefs.join(";")
                        }
                        if (comments && comments.length) {
                            if (stmt.comment) stmt.comment = stmt.comment.concat(comments);
                            else stmt.comment = comments;
                        }
                    }
                }
            }
        }

        function getTypeScriptStatementBlock(node: ts.Node, prefix?: string, err?: string): StatementNode {
            if (options.errorOnGreyBlocks)
                error(node);

            const r = mkStmt(pxtc.TS_STATEMENT_TYPE, node);
            r.mutation = {}

            trackVariableUsagesInText(node);

            let text = node.getText();
            const start = node.getStart();
            const end = node.getEnd();

            text = applyRenamesInRange(text, start, end);

            // Mark comments or else they are emitted twice
            markCommentsInRange(node, commentMap);

            if (prefix) {
                text = prefix + text;
            }

            const declaredVariables: string[] = [];
            if (node.kind === SK.VariableStatement) {
                for (const declaration of (node as ts.VariableStatement).declarationList.declarations) {
                    declaredVariables.push(getVariableName(declaration.name as ts.Identifier));
                }
            }
            else if (node.kind === SK.VariableDeclaration) {
                declaredVariables.push(getVariableName((node as ts.VariableDeclaration).name as ts.Identifier));
            }

            if (declaredVariables.length) {
                r.mutation["declaredvars"] = declaredVariables.join(",");
            }

            const parts = text.split("\n");
            r.mutation["numlines"] = parts.length.toString();

            if (err && options.includeGreyBlockMessages) {
                r.mutation["error"] = U.htmlEscape(err);
            }

            parts.forEach((p, i) => {
                r.mutation[`line${i}`] = U.htmlEscape(p);
            });

            return r;
        }

        function getContinueStatementBlock(node: ts.Node): StatementNode {
            const r = mkStmt(pxtc.TS_CONTINUE_TYPE, node);
            return r;
        }

        function getBreakStatementBlock(node: ts.Node): StatementNode {
            const r = mkStmt(pxtc.TS_BREAK_TYPE, node);
            return r;
        }

        function getDebuggerStatementBlock(node: ts.Node): StatementNode {
            const r = mkStmt(pxtc.TS_DEBUGGER_TYPE, node);
            return r;
        }

        function getReturnStatementBlock(node: ts.ReturnStatement): StatementNode {
            const r = mkStmt(pxtc.TS_RETURN_STATEMENT_TYPE, node);
            if (node.expression) {
                r.inputs = [
                    mkValue("RETURN_VALUE", getOutputBlock(node.expression), numberType)
                ];
            }
            else {
                r.mutation = {
                    "no_return_value": "true"
                };
            }
            return r
        }

        function getImageLiteralStatement(node: ts.CallExpression, info: pxtc.CallInfo) {
            let arg = node.arguments[0];
            if (arg.kind != SK.StringLiteral && arg.kind != SK.NoSubstitutionTemplateLiteral) {
                error(node)
                return undefined;
            }

            const attributes = attrs(info);
            const res = mkStmt(attributes.blockId, node);
            res.fields = [];

            const leds = ((arg as ts.StringLiteral).text || '').replace(/\s+/g, '');
            const nc = (attributes.imageLiteralColumns || 5) * attributes.imageLiteral;
            const nr = attributes.imageLiteralRows || 5;
            const nleds = nc * nr;
            if (nleds != leds.length) {
                error(node, Util.lf("Invalid image pattern ({0} expected vs {1} actual)", nleds, leds.length));
                return undefined;
            }
            let ledString = '';
            for (let r = 0; r < nr; ++r) {
                for (let c = 0; c < nc; ++c) {
                    ledString += /[#*1]/.test(leds[r * nc + c]) ? '#' : '.';
                }
                ledString += '\n';
            }
            res.fields.push(getField(`LEDS`, `\`${ledString}\``));

            return res;
        }

        function getBinaryExpressionStatement(n: ts.BinaryExpression): StatementNode {
            const name = (n.left as ts.Identifier).text;

            switch (n.operatorToken.kind) {
                case SK.EqualsToken:
                    if (n.left.kind === SK.Identifier) {
                        return getVariableSetOrChangeBlock(n, n.left as ts.Identifier, n.right);
                    }
                    else if (n.left.kind == SK.PropertyAccessExpression) {
                        return getPropertySetBlock(n, n.left as ts.PropertyAccessExpression, n.right, "@set@");
                    }
                    else {
                        return getArraySetBlock(n, n.left as ts.ElementAccessExpression, n.right);
                    }
                case SK.PlusEqualsToken:
                    if (isTextJoin(n)) {
                        const r = mkStmt("variables_set", n);
                        const renamed = getVariableName(n.left as ts.Identifier);
                        trackVariableUsage(renamed, ReferenceType.InBlocksOnly);
                        r.inputs = [mkValue("VALUE", getTextJoin(n), numberType)];
                        r.fields = [getField("VAR", renamed)];
                        return r;
                    }

                    if (n.left.kind == SK.PropertyAccessExpression)
                        return getPropertySetBlock(n, n.left as ts.PropertyAccessExpression, n.right, "@change@");
                    else
                        return getVariableSetOrChangeBlock(n, n.left as ts.Identifier, n.right, true);
                case SK.MinusEqualsToken:
                    const r = mkStmt("variables_change", n);
                    r.inputs = [mkValue("VALUE", negateNumericNode(n.right), numberType)];
                    r.fields = [getField("VAR", getVariableName(n.left as ts.Identifier))];

                    return r;
                default:
                    error(n, Util.lf("Unsupported operator token in statement {0}", SK[n.operatorToken.kind]));
                    return undefined;
            }
        }

        function getWhileStatement(n: ts.WhileStatement): StatementNode {
            const r = mkStmt("device_while", n);
            r.inputs = [getConditionalInput("COND", n.expression)];
            r.handlers = [{ name: "DO", statement: getStatementBlock(n.statement) }];
            return r;
        }

        function getIfStatement(n: ts.IfStatement): StatementNode {
            let flatif = flattenIfStatement(n);

            const r = mkStmt("controls_if", n);
            r.mutation = {
                "elseif": (flatif.ifStatements.length - 1).toString(),
                "else": flatif.elseStatement ? "1" : "0"
            };
            r.inputs = [];
            r.handlers = [];

            flatif.ifStatements.forEach((stmt, i) => {
                let statement = getStatementBlock(stmt.thenStatement)
                r.inputs.push(getConditionalInput("IF" + i, (stmt as ts.IfStatement).expression));
                r.handlers.push({ name: "DO" + i, statement });
            });

            if (flatif.elseStatement) {
                let statement = getStatementBlock(flatif.elseStatement);
                r.handlers.push({ name: "ELSE", statement });
            }

            return r;
        }

        function getConditionalInput(name: string, expr: Expression) {
            const err = checkConditionalExpression(expr);
            if (err) {
                const tsExpr = getTypeScriptExpressionBlock(expr);
                return mkValue(name, tsExpr, booleanType);
            } else {
                return getValue(name, expr, booleanType);
            }
        }

        function checkConditionalExpression(expr: Expression) {
            const unwrappedExpr = unwrapNode(expr);

            switch (unwrappedExpr.kind) {
                case SK.TrueKeyword:
                case SK.FalseKeyword:
                case SK.Identifier:
                case SK.ElementAccessExpression:
                    return undefined;
                case SK.BinaryExpression:
                    return checkBooleanBinaryExpression(unwrappedExpr as BinaryExpression);
                case SK.CallExpression:
                    return checkBooleanCallExpression(unwrappedExpr as CallExpression);
                case SK.PrefixUnaryExpression:
                    if ((unwrappedExpr as PrefixUnaryExpression).operator === SK.ExclamationToken) {
                        return undefined;
                    } // else fall through
                default:
                    return Util.lf("Conditions must evaluate to booleans or identifiers");
            }

            function checkBooleanBinaryExpression(n: BinaryExpression) {
                switch (n.operatorToken.kind) {
                    case SK.EqualsEqualsToken:
                    case SK.EqualsEqualsEqualsToken:
                    case SK.ExclamationEqualsToken:
                    case SK.ExclamationEqualsEqualsToken:
                    case SK.LessThanToken:
                    case SK.LessThanEqualsToken:
                    case SK.GreaterThanToken:
                    case SK.GreaterThanEqualsToken:
                    case SK.AmpersandAmpersandToken:
                    case SK.BarBarToken:
                        return undefined;
                    default:
                        return Util.lf("Binary expressions in conditionals must evaluate to booleans");
                }
            }

            function checkBooleanCallExpression(n: CallExpression) {
                const callInfo: pxtc.CallInfo = pxtc.pxtInfo(n).callInfo;
                if (callInfo) {
                    const api = env.blocks.apis.byQName[callInfo.qName];
                    if (api && api.retType == "boolean") {
                        return undefined;
                    }
                    else if (ts.isIdentifier(n.expression) && env.declaredFunctions[n.expression.text]) {
                        // User functions have a return type of "any" in blocks so they are safe to decompile
                        return undefined;
                    }
                }
                return Util.lf("Only functions that return booleans are allowed as conditions");
            }
        }

        function getForStatement(n: ts.ForStatement): StatementNode {
            const initializer = n.initializer as ts.VariableDeclarationList;
            const indexVar = (initializer.declarations[0].name as ts.Identifier).text;
            const condition = n.condition as ts.BinaryExpression

            const renamed = getVariableName(initializer.declarations[0].name as ts.Identifier);

            let r: StatementNode;

            if (condition.operatorToken.kind === SK.LessThanToken && !checkForVariableUsages(n.statement)) {
                r = mkStmt("controls_repeat_ext", n);
                r.fields = [];
                r.inputs = [getValue("TIMES", condition.right, wholeNumberType)];
                r.handlers = [];
            }
            else {
                r = mkStmt("pxt_controls_for", n);
                r.fields = [];
                r.inputs = [];
                r.handlers = [];
                r.inputs = [getDraggableVariableBlock("VAR", renamed)];

                if (condition.operatorToken.kind === SK.LessThanToken) {
                    const unwrappedRightSide = unwrapNode(condition.right);
                    if (unwrappedRightSide.kind === SK.NumericLiteral) {
                        const decrementedValue = parseFloat((unwrappedRightSide as LiteralExpression).text) - 1;
                        const valueField = getNumericLiteral(decrementedValue + "");
                        r.inputs.push(mkValue("TO", valueField, wholeNumberType));
                    } else {
                        const ex = mkExpr("math_arithmetic", n);
                        ex.fields = [getField("OP", "MINUS")];
                        ex.inputs = [
                            getValue("A", unwrappedRightSide, numberType),
                            getValue("B", 1, numberType)
                        ];
                        r.inputs.push(mkValue("TO", ex, wholeNumberType));
                    }
                }
                else if (condition.operatorToken.kind === SK.LessThanEqualsToken) {
                    r.inputs.push(getValue("TO", condition.right, wholeNumberType));
                }
            }

            const statement = getStatementBlock(n.statement);
            r.handlers = [{ name: "DO", statement  }];
            return r;

            function checkForVariableUsages(node: Node): boolean {
                if (node.kind === SK.Identifier && getVariableName(node as ts.Identifier) === renamed) {
                    return true;
                }

                return ts.forEachChild(node, checkForVariableUsages);
            }
        }

        function getForOfStatement(n: ts.ForOfStatement): StatementNode {
            const initializer = n.initializer as ts.VariableDeclarationList;
            const renamed = getVariableName(initializer.declarations[0].name as ts.Identifier);

            const r = mkStmt("pxt_controls_for_of", n);
            r.inputs = [getValue("LIST", n.expression), getDraggableVariableBlock("VAR", renamed)];
            const statement = getStatementBlock(n.statement);
            r.handlers = [{ name: "DO", statement  }];

            return r
        }

        function getVariableSetOrChangeBlock(n: ts.Node, name: ts.Identifier, value: Node | number, changed = false, overrideName = false): StatementNode {
            const renamed = getVariableName(name);
            trackVariableUsage(renamed, ReferenceType.InBlocksOnly);
            // We always do a number shadow even if the variable is not of type number
            const r = mkStmt(changed ? "variables_change" : "variables_set", n.parent || n);
            r.inputs = [getValue("VALUE", value, numberType)];
            r.fields = [getField("VAR", renamed)]
            return r;
        }

        function getArraySetBlock(n: ts.BinaryExpression, left: ts.ElementAccessExpression, right: ts.Expression): StatementNode {
            const r = mkStmt("lists_index_set", n);
            r.inputs = [
                getValue("LIST", left.expression),
                getValue("INDEX", left.argumentExpression, numberType),
                getValue("VALUE", right)
            ];
            return r;
        }

        function getPropertySetBlock(n: ts.Node, left: ts.PropertyAccessExpression, right: ts.Expression, tp: string) {
            return getPropertyBlock(n, left, right, tp) as StatementNode
        }

        function getPropertyGetBlock(n: ts.Node, left: ts.PropertyAccessExpression) {
            return getPropertyBlock(n, left, null, "@get@") as ExpressionNode
        }

        function getPropertyBlock(n: ts.Node, left: ts.PropertyAccessExpression, right: ts.Expression, tp: string): StatementNode | ExpressionNode {
            const info: pxtc.CallInfo = pxtc.pxtInfo(left).callInfo
            const sym = env.blocks.apis.byQName[info ? info.qName : ""]
            if (!sym || !sym.attributes.blockCombine) {
                error(left);
                return undefined;
            }
            const qName = `${sym.namespace}.${sym.retType}.${tp}`;
            const setter = env.blocks.blocks.find(b => b.qName == qName)
            const r = right ? mkStmt(setter.attributes.blockId, n) : mkExpr(setter.attributes.blockId, n)
            const pp = setter.attributes._def.parameters;

            let fieldValue = info.qName;
            if (setter.combinedProperties) {
                // getters/setters have annotations at the end of their names so look them up
                setter.combinedProperties.forEach(pName => {
                    if (pName.indexOf(info.qName) === 0 && pName.charAt(info.qName.length) === "@") {
                        fieldValue = pName;
                    }
                })
            }

            r.inputs = [getValue(pp[0].name, left.expression)];
            r.fields = [getField(pp[1].name, fieldValue)];
            if (right)
                r.inputs.push(getValue(pp[2].name, right));
            return r;
        }

        function getVariableDeclarationStatement(n: ts.VariableDeclaration): StatementNode {
            if (addVariableDeclaration(n)) {
                return getVariableSetOrChangeBlock(n, n.name as ts.Identifier, n.initializer)
            }
            return undefined;
        }

        function getIncrementStatement(node: ts.PrefixUnaryExpression | PostfixUnaryExpression): StatementNode {
            const isPlusPlus = node.operator === SK.PlusPlusToken;

            if (!isPlusPlus && node.operator !== SK.MinusMinusToken) {
                error(node);
                return undefined;
            }

            return getVariableSetOrChangeBlock(node, node.operand as ts.Identifier, isPlusPlus ? 1 : -1, true);
        }

        function getFunctionDeclaration(n: ts.FunctionDeclaration): StatementNode {
            const name = getVariableName(n.name);

            env.localReporters.push(n.parameters.map(p => {
                return {
                    name: p.name.getText(),
                    type: p.type.getText()
                } as PropertyDesc;
            }));

            const statements = getStatementBlock(n.body);

            env.localReporters.pop();

            let r: StatementNode;

            r = mkStmt("function_definition", n);
            r.mutation = {
                name
            };
            if (n.parameters) {
                r.mutationChildren = [];
                n.parameters.forEach(p => {
                    const paramName = p.name.getText();
                    r.mutationChildren.push({
                        nodeName: "arg",
                        attributes: {
                            name: paramName,
                            type: p.type.getText(),
                            id: env.functionParamIds[name][paramName]
                        }
                    });
                });
            }

            r.handlers = [{ name: "STACK", statement: statements }];
            return r;
        }

        function getCallStatement(node: ts.CallExpression, asExpression: boolean): StatementNode | ExpressionNode {
            const info: DecompilerCallInfo = pxtc.pxtInfo(node).callInfo
            const attributes = attrs(info);

            if (info.qName == "Math.pow") {
                const r = mkExpr("math_arithmetic", node);
                r.inputs = [
                    mkValue("A", getOutputBlock(node.arguments[0]), numberType),
                    mkValue("B", getOutputBlock(node.arguments[1]), numberType)
                ];
                r.fields = [getField("OP", "POWER")];
                return r;
            }
            else if (pxt.Util.startsWith(info.qName, "Math.")) {
                const op = info.qName.substring(5);
                if (isSupportedMathFunction(op)) {
                    let r: ExpressionNode;

                    if (isRoundingFunction(op)) {
                        r = mkExpr("math_js_round", node);
                    } else {
                        r = mkExpr("math_js_op", node);
                        let opType: string;
                        if (isUnaryMathFunction(op)) opType = "unary";
                        else if (isInfixMathFunction(op)) opType = "infix";
                        else opType = "binary";

                        r.mutation = { "op-type": opType };
                    }

                    r.inputs = info.args.map((arg, index) => mkValue("ARG" + index, getOutputBlock(arg), "math_number"))
                    r.fields = [getField("OP", op)];

                    return r;
                }
            }

            if (attributes.blockId === pxtc.PAUSE_UNTIL_TYPE) {
                const r = mkStmt(pxtc.PAUSE_UNTIL_TYPE, node);
                const lambda = node.arguments[0] as (ts.FunctionExpression | ts.ArrowFunction);

                let condition: ts.Node;

                if (lambda.body.kind === SK.Block) {
                    // We already checked to make sure the body is a single return statement
                    condition = ((lambda.body as ts.Block).statements[0] as ts.ReturnStatement).expression;
                }
                else {
                    condition = lambda.body;
                }

                r.inputs = [mkValue("PREDICATE", getOutputBlock(condition), "logic_boolean")];
                return r;
            }

            if (!attributes.blockId || !attributes.block) {
                const builtin = pxt.blocks.builtinFunctionInfo[info.qName];
                if (!builtin) {
                    const name = getVariableName(node.expression as ts.Identifier);
                    if (env.declaredFunctions[name]) {
                        let r: StatementNode;

                        let isStatement = true;

                        if (info.isExpression) {
                            const [parent] = getParent(node);
                            isStatement = parent && parent.kind === SK.ExpressionStatement;
                        }

                        r = mkStmt(isStatement ? "function_call" : "function_call_output", node);
                        if (info.args.length) {
                            r.mutationChildren = [];
                            r.inputs = [];
                            env.declaredFunctions[name].parameters.forEach((p, i) => {
                                const paramName = p.name.getText();
                                const argId = env.functionParamIds[name][paramName];
                                r.mutationChildren.push({
                                    nodeName: "arg",
                                    attributes: {
                                        name: paramName,
                                        type: p.type.getText(),
                                        id: argId
                                    }
                                });
                                const argBlock = getOutputBlock(info.args[i]);
                                const value = mkValue(argId, argBlock);
                                r.inputs.push(value);
                            });
                        }
                        r.mutation = { name };
                        return r;
                    }
                    else {
                        return getTypeScriptStatementBlock(node);
                    }
                }
                attributes.blockId = builtin.blockId;
            }

            if (attributes.imageLiteral) {
                return getImageLiteralStatement(node, info);
            }

            if (ts.isFunctionLike(info.decl)) {
                // const decl = info.decl as FunctionLikeDeclaration;
                // if (decl.parameters && decl.parameters.length === 1 && ts.isRestParameter(decl.parameters[0])) {
                //     openCallExpressionBlockWithRestParameter(node, info);
                //     return;
                // }
            }

            const args = paramList(info, env.blocks);
            const api = env.blocks.apis.byQName[info.decompilerBlockAlias || info.qName];
            const comp = pxt.blocks.compileInfo(api);

            const r = asExpression ? mkExpr(attributes.blockId, node)
                : mkStmt(attributes.blockId, node);

            const addInput = (v: ValueNode) => (r.inputs || (r.inputs = [])).push(v);
            const addField = (f: FieldNode) => (r.fields || (r.fields = [])).push(f);

            if (info.qName == "Math.max") {
                addField({
                    kind: "field",
                    name: "op",
                    value: "max"
                });
            }

            let optionalCount = 0;
            args.forEach((arg, i) => {
                let e = arg.value;
                let shadowMutation: pxt.Map<string>;
                const param = arg.param;
                const paramInfo = arg.info;

                const paramComp = comp.parameters[comp.thisParameter ? i - 1 : i];
                const paramRange = paramComp && paramComp.range;
                if (paramRange) {
                    const min = paramRange['min'];
                    const max = paramRange['max'];
                    shadowMutation = { 'min': min.toString(), 'max': max.toString() };
                }

                if (i === 0 && attributes.defaultInstance) {
                    if (e.getText() === attributes.defaultInstance) {
                        return;
                    }
                    else {
                        r.mutation = { "showing": "true" };
                    }
                }

                if (attributes.mutatePropertyEnum && i === info.args.length - 2) {
                    // Implicit in the blocks
                    return;
                }

                if (param && param.isOptional) {
                    ++optionalCount;
                }

                let shadowBlockInfo: SymbolInfo;
                if (param && param.shadowBlockId) {
                    shadowBlockInfo = blocksInfo.blocksById[param.shadowBlockId];
                }

                if (e.kind === SK.CallExpression) {
                    // Many enums have shim wrappers that need to be unwrapped if used
                    // in a parameter that is of an enum type. By default, enum parameters
                    // are dropdown fields (not value inputs) so we want to decompile the
                    // inner enum value as a field and not the shim block as a value
                    const shimCall: pxtc.CallInfo = pxtc.pxtInfo(e).callInfo;
                    const shimAttrs: CommentAttrs = shimCall && attrs(shimCall);
                    if (shimAttrs && shimAttrs.shim === "TD_ID" && paramInfo.isEnum) {
                        e = unwrapNode(shimCall.args[0]) as ts.Expression;
                    }
                }

                if (param && paramInfo && paramInfo.isEnum && e.kind === SK.Identifier) {
                    addField(getField(U.htmlEscape(param.definitionName), pxtInfo(e).commentAttrs.enumIdentity));
                    return;
                }

                if (param && param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileArgumentAsString]) {
                    addField(getField(U.htmlEscape(param.definitionName), Util.htmlEscape(e.getText())));
                    return;
                }

                switch (e.kind) {
                    case SK.FunctionExpression:
                    case SK.ArrowFunction:
                        let expBody = (e as ArrowFunction | FunctionExpression).body;
                        const m = getDestructuringMutation(e as ArrowFunction);
                        let mustPopLocalScope = false;
                        if (m) {
                            r.mutation = m;
                        }
                        else {
                            let arrow = e as ArrowFunction;
                            const sym = blocksInfo.blocksById[attributes.blockId];
                            const paramDesc = sym.parameters[comp.thisParameter ? i - 1 : i];
                            const addDraggableInput = (arg: PropertyDesc, varName: string) => {
                                if (attributes.draggableParameters === "reporter") {
                                    addInput(mkDraggableReporterValue("HANDLER_DRAG_PARAM_" + arg.name, varName, arg.type));
                                } else {
                                    addInput(getDraggableVariableBlock("HANDLER_DRAG_PARAM_" + arg.name, varName));
                                }
                            };
                            if (arrow.parameters.length) {
                                if (attributes.optionalVariableArgs) {
                                    r.mutation = {
                                        "numargs": arrow.parameters.length.toString()
                                    };
                                    arrow.parameters.forEach((parameter, i) => {
                                        r.mutation["arg" + i] = (parameter.name as ts.Identifier).text;
                                    });
                                }
                                else {
                                    arrow.parameters.forEach((parameter, i) => {
                                        const arg = paramDesc.handlerParameters[i];
                                        if (attributes.draggableParameters) {
                                            addDraggableInput(arg, (parameter.name as ts.Identifier).text);
                                        }
                                        else {
                                            addField(getField("HANDLER_" + arg.name, (parameter.name as ts.Identifier).text));
                                        }
                                    });

                                }
                            }
                            if (attributes.draggableParameters) {
                                if (arrow.parameters.length < paramDesc.handlerParameters.length) {
                                    for (let i = arrow.parameters.length; i < paramDesc.handlerParameters.length; i++) {
                                        const arg = paramDesc.handlerParameters[i];
                                        addDraggableInput(arg, arg.name);
                                    }
                                }
                                if (attributes.draggableParameters === "reporter") {
                                    // Push the parameter descriptions onto the local scope stack
                                    // so the getStatementBlock() below knows that these parameters
                                    // should be decompiled as reporters instead of variables.
                                    env.localReporters.push(paramDesc.handlerParameters);
                                    mustPopLocalScope = true;
                                }
                            }
                        }
                        const statement = getStatementBlock(e);
                        (r.handlers || (r.handlers = [])).push({ name: "HANDLER", statement });

                        if (mustPopLocalScope) {
                            env.localReporters.pop();
                        }
                        break;
                    case SK.PropertyAccessExpression:
                        const callInfo = pxtc.pxtInfo(e).callInfo as pxtc.CallInfo;
                        const aName = U.htmlEscape(param.definitionName);
                        const argAttrs = attrs(callInfo);

                        if (shadowBlockInfo && shadowBlockInfo.attributes.shim === "TD_ID") {
                            addInput(mkValue(aName, getPropertyAccessExpression(e as PropertyAccessExpression, false, param.shadowBlockId), param.shadowBlockId, shadowMutation));
                        }
                        else if (paramInfo && paramInfo.isEnum || callInfo && (argAttrs.fixedInstance || argAttrs.blockIdentity === info.qName)) {
                            addField(getField(aName, (getPropertyAccessExpression(e as PropertyAccessExpression, true) as TextNode).value))
                        }
                        else {
                            addInput(getValue(aName, e, param.shadowBlockId, shadowMutation))
                        }
                        break;
                    case SK.BinaryExpression:
                        if (param && param.shadowOptions && param.shadowOptions.toString) {
                            const be = e as BinaryExpression;
                            if (be.operatorToken.kind === SK.PlusToken && isEmptyStringNode(be.left)) {
                                addInput(getValue(U.htmlEscape(param.definitionName), be.right, param.shadowBlockId || "text"));
                                break;
                            }
                        }
                        addInput(getValue(U.htmlEscape(param.definitionName), e, param.shadowBlockId, shadowMutation))
                        break;
                    default:
                        let v: ValueNode;
                        const vName = U.htmlEscape(param.definitionName);
                        let defaultV = true;

                        if (info.qName == "Math.random") {
                            v = mkValue(vName, getMathRandomArgumentExpresion(e), numberType, shadowMutation);
                            defaultV = false;
                        } else if (isLiteralNode(e)) {
                            // Remove quotes on strings
                            const fieldText = param.fieldEditor == 'text' ? (e as ts.StringLiteral).text : e.getText();
                            const isFieldBlock = param.shadowBlockId && !isLiteralBlockType(param.shadowBlockId);

                            if (decompileLiterals(param) && param.fieldOptions['onParentBlock']) {
                                addField(getField(vName, fieldText));
                                return;
                            }
                            else if (isFieldBlock) {
                                const field = fieldBlockInfo(param.shadowBlockId);
                                if (field && decompileLiterals(field)) {
                                    const fieldBlock = getFieldBlock(param.shadowBlockId, field.definitionName, fieldText, true);
                                    if (param.shadowOptions) {
                                        fieldBlock.mutation = { "customfield": Util.htmlEscape(JSON.stringify(param.shadowOptions)) };
                                    }
                                    v = mkValue(vName, fieldBlock, param.shadowBlockId, shadowMutation);
                                    defaultV = false;
                                }
                            }
                        }
                        else if (e.kind === SK.TaggedTemplateExpression && param.fieldOptions && param.fieldOptions[DecompileParamKeys.TaggedTemplate]) {
                            addField(getField(vName, Util.htmlEscape(e.getText())));
                            return;
                        }
                        if (defaultV) {
                            v = getValue(vName, e, param.shadowBlockId, shadowMutation);
                        }

                        addInput(v);
                        break;
                }
            });

            if (optionalCount) {
                if (!r.mutation) r.mutation = {};
                r.mutation["_expanded"] = optionalCount.toString();
            }

            return r;
        }

        function fieldBlockInfo(blockId: string) {
            if (blocksInfo.blocksById[blockId]) {
                const comp = pxt.blocks.compileInfo(blocksInfo.blocksById[blockId]);
                if (!comp.thisParameter && comp.parameters.length === 1) {
                    return comp.parameters[0];
                }
            }
            return undefined;
        }

        function decompileLiterals(param: pxt.blocks.BlockParameter) {
            return param && param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileLiterals];
        }

        // function openCallExpressionBlockWithRestParameter(call: ts.CallExpression, info: pxtc.CallInfo) {
        //     openBlockTag(info.attrs.blockId);
        //     write(`<mutation count="${info.args.length}" />`)
        //     info.args.forEach((expression, index) => {
        //         emitValue("value_input_" + index, expression, numberType);
        //     });
        // }

        function getDestructuringMutation(callback: ts.ArrowFunction): pxt.Map<string> {
            const bindings = getObjectBindingProperties(callback);
            if (bindings) {
                return {
                    "callbackproperties": bindings[0].join(","),
                    "renamemap": Util.htmlEscape(JSON.stringify(bindings[1]))
                };
            }

            return undefined;
        }

        function getMathRandomArgumentExpresion(e: ts.Expression): OutputNode {
            switch (e.kind) {
                case SK.NumericLiteral:
                    const n = e as LiteralExpression;
                    return getNumericLiteral((parseInt(n.text) - 1).toString());
                case SK.BinaryExpression:
                    const op = e as BinaryExpression;
                    if (op.operatorToken.kind == SK.PlusToken && (op.right as any).text == "1") {
                        return getOutputBlock(op.left);
                    }
                default:
                    //This will definitely lead to an error, but the above are the only two cases generated by blocks
                    return getOutputBlock(e);
            }
        }

        function getArrowFunctionStatement(n: ts.ArrowFunction, next: ts.Node[]) {
            return getStatementBlock(n.body, next)
        }

        function flattenIfStatement(n: ts.IfStatement): {
            ifStatements: {
                expression: ts.Expression;
                thenStatement: ts.Statement;
            }[];
            elseStatement: ts.Statement;
        } {
            let r = {
                ifStatements: [{
                    expression: n.expression,
                    thenStatement: n.thenStatement
                }],
                elseStatement: n.elseStatement
            }
            if (n.elseStatement && n.elseStatement.kind == SK.IfStatement) {
                let flat = flattenIfStatement(n.elseStatement as ts.IfStatement);
                r.ifStatements = r.ifStatements.concat(flat.ifStatements);
                r.elseStatement = flat.elseStatement;
            }
            return r;
        }

        function codeBlock(statements: NodeArray<Node>, next?: ts.Node[], topLevel = false, parent?: ts.Node, emitOnStart = false) {
            const eventStatements: ts.Node[] = [];
            const blockStatements: ts.Node[] = next || [];

            // Go over the statements in reverse so that we can insert the nodes into the existing list if there is one
            for (let i = statements.length - 1; i >= 0; i--) {
                const statement = statements[i];
                if ((statement.kind === SK.FunctionDeclaration ||
                    (statement.kind == SK.ExpressionStatement && isEventExpression(statement as ts.ExpressionStatement))) &&
                    !checkStatement(statement, env, false, topLevel)) {
                    eventStatements.unshift(statement)
                }
                else {
                    blockStatements.unshift(statement)
                }
            }

            eventStatements.map(n => getStatementBlock(n, undefined, undefined, false, topLevel)).forEach(emitStatementNode);

            if (blockStatements.length) {
                // wrap statement in "on start" if top level
                const stmtNode = blockStatements.shift();
                const stmt = getStatementBlock(stmtNode, blockStatements, parent, false, topLevel);
                if (emitOnStart) {
                    // Preserve any variable edeclarations that were never used
                    let current = stmt;
                    let currentNode: ts.Node = stmtNode;
                    autoDeclarations.forEach(([name, node]) => {
                        if (varUsages[name] === ReferenceType.InBlocksOnly) {
                            return;
                        }
                        let e = (node as ts.VariableDeclaration).initializer;
                        let v: StatementNode;
                        if (varUsages[name] === ReferenceType.InTextBlocks) {
                            // If a variable is referenced inside a "grey" block, we need
                            // to be conservative because our type inference might not work
                            // on the round trip
                            v = getTypeScriptStatementBlock(node, "let ");
                        }
                        else {
                            v = getVariableSetOrChangeBlock(stmtNode, (node as ts.VariableDeclaration).name as ts.Identifier, (node as ts.VariableDeclaration).initializer, false, true);
                        }
                        v.next = current;
                        current = v;
                        currentNode = node;
                    });

                    if (current) {
                        const r = mkStmt(ts.pxtc.ON_START_TYPE, currentNode);
                        r.handlers = [{
                            name: "HANDLER",
                            statement: current
                        }];
                        return r;
                    }
                    else {
                        maybeEmitEmptyOnStart(stmt);
                    }
                }
                return stmt;
            }
            else if (emitOnStart) {
                maybeEmitEmptyOnStart(undefined);
            }

            return undefined;
        }

        function maybeEmitEmptyOnStart(node: StatementNode) {
            if (options.alwaysEmitOnStart) {
                openBlockTag(ts.pxtc.ON_START_TYPE, node);
                closeBlockTag();
            }
        }

        function trackVariableUsage(name: string, type: ReferenceType) {
            if (varUsages[name] !== ReferenceType.InTextBlocks) {
                varUsages[name] = type;
            }
        }

        function trackVariableUsagesInText(node: ts.Node) {
            ts.forEachChild(node, (n) => {
                if (n.kind === SK.Identifier) {
                    trackVariableUsage(getVariableName(n as ts.Identifier), ReferenceType.InTextBlocks)
                }
                trackVariableUsagesInText(n);
            })
        }

        function trackAutoDeclaration(n: ts.VariableDeclaration) {
            autoDeclarations.push([getVariableName(n.name as ts.Identifier), n]);
        }

        function addVariableDeclaration(node: VariableDeclaration): boolean {
            if (node.name.kind !== SK.Identifier) {
                error(node, Util.lf("Variable declarations may not use binding patterns"))
                return false;
            }
            else if (!node.initializer) {
                error(node, Util.lf("Variable declarations must have an initializer"))
                return false;
            }
            return true;
        }

        function getVariableName(name: ts.Identifier) {
            if (renameMap) {
                const rename = renameMap.getRenameForPosition(name.getStart());
                if (rename) {
                    return unescapeVarName(rename.name);
                }
            }
            return unescapeVarName(name.text);
        }
    }

    function checkStatement(node: ts.Node, env: DecompilerEnv, asExpression = false, topLevel = false): string {
        switch (node.kind) {
            case SK.WhileStatement:
            case SK.IfStatement:
            case SK.Block:
                return undefined;
            case SK.ExpressionStatement:
                return checkStatement((node as ts.ExpressionStatement).expression, env, asExpression, topLevel);
            case SK.VariableStatement:
                return checkVariableStatement(node as ts.VariableStatement, env);
            case SK.CallExpression:
                return checkCall(node as ts.CallExpression, env, asExpression, topLevel);
            case SK.VariableDeclaration:
                return checkVariableDeclaration(node as ts.VariableDeclaration, env);
            case SK.PostfixUnaryExpression:
            case SK.PrefixUnaryExpression:
                return checkIncrementorExpression(node as (ts.PrefixUnaryExpression | ts.PostfixUnaryExpression));
            case SK.FunctionExpression:
            case SK.ArrowFunction:
                return checkArrowFunction(node as ts.ArrowFunction, env);
            case SK.BinaryExpression:
                return checkBinaryExpression(node as ts.BinaryExpression, env);
            case SK.ForStatement:
                return checkForStatement(node as ts.ForStatement);
            case SK.ForOfStatement:
                return checkForOfStatement(node as ts.ForOfStatement);
            case SK.FunctionDeclaration:
                return checkFunctionDeclaration(node as ts.FunctionDeclaration, topLevel);
            case SK.EnumDeclaration:
                return checkEnumDeclaration(node as ts.EnumDeclaration, topLevel);
            case SK.ModuleDeclaration:
                return checkNamespaceDeclaration(node as ts.NamespaceDeclaration);
            case SK.ReturnStatement:
                return checkReturnStatement(node as ts.ReturnStatement);
            case SK.BreakStatement:
            case SK.ContinueStatement:
            case SK.DebuggerStatement:
            case SK.EmptyStatement:
                return undefined;
        }

        return Util.lf("Unsupported statement in block: {0}", SK[node.kind]);

        function checkForStatement(n: ts.ForStatement) {
            if (!n.initializer || !n.incrementor || !n.condition) {
                return Util.lf("for loops must have an initializer, incrementor, and condition");
            }

            if (n.initializer.kind !== SK.VariableDeclarationList) {
                return Util.lf("only variable declarations are permitted in for loop initializers");
            }

            const initializer = n.initializer as ts.VariableDeclarationList;

            if (!initializer.declarations) {
                return Util.lf("for loop with out-of-scope variables not supported");
            }
            if (initializer.declarations.length != 1) {
                return Util.lf("for loop with multiple variables not supported");
            }

            const assignment = initializer.declarations[0] as VariableDeclaration;
            if (assignment.initializer.kind !== SK.NumericLiteral || (assignment.initializer as ts.LiteralExpression).text !== "0") {
                return Util.lf("for loop initializers must be initialized to 0");
            }

            const indexVar = (assignment.name as ts.Identifier).text;
            if (!incrementorIsValid(indexVar)) {
                return Util.lf("for loop incrementors may only increment the variable declared in the initializer");
            }

            if (n.condition.kind !== SK.BinaryExpression) {
                return Util.lf("for loop conditionals must be binary comparison operations")
            }

            const condition = n.condition as ts.BinaryExpression
            if (condition.left.kind !== SK.Identifier || (condition.left as ts.Identifier).text !== indexVar) {
                return Util.lf("left side of for loop conditional must be the variable declared in the initializer")
            }

            if (condition.operatorToken.kind !== SK.LessThanToken && condition.operatorToken.kind !== SK.LessThanEqualsToken) {
                return Util.lf("for loop conditional operator must be either < or <=");
            }

            return undefined;

            function incrementorIsValid(varName: string): boolean {
                if (n.incrementor.kind === SK.PostfixUnaryExpression || n.incrementor.kind === SK.PrefixUnaryExpression) {
                    const incrementor = n.incrementor as ts.PostfixUnaryExpression | ts.PrefixUnaryExpression;
                    if (incrementor.operator === SK.PlusPlusToken && incrementor.operand.kind === SK.Identifier) {
                        return (incrementor.operand as ts.Identifier).text === varName;
                    }
                }
                return false;
            }
        }

        function checkForOfStatement(n: ts.ForOfStatement) {
            if (n.initializer.kind !== SK.VariableDeclarationList) {
                return Util.lf("only variable declarations are permitted in for of loop initializers");
            }

            // VariableDeclarationList in ForOfStatements are guranteed to have one declaration
            return undefined;
        }

        function checkBinaryExpression(n: ts.BinaryExpression, env: DecompilerEnv) {
            if (n.left.kind === SK.ElementAccessExpression) {
                if (n.operatorToken.kind !== SK.EqualsToken) {
                    return Util.lf("Element access expressions may only be assigned to using the equals operator");
                }
            }
            else if (n.left.kind === SK.PropertyAccessExpression) {
                if (n.operatorToken.kind !== SK.EqualsToken &&
                    n.operatorToken.kind !== SK.PlusEqualsToken) {
                    return Util.lf("Property access expressions may only be assigned to using the = and += operators");
                } else {
                    return checkExpression(n.left, env);
                }
            }
            else if (n.left.kind === SK.Identifier) {
                switch (n.operatorToken.kind) {
                    case SK.EqualsToken:
                        return checkExpression(n.right, env);
                    case SK.PlusEqualsToken:
                    case SK.MinusEqualsToken:
                        return undefined;
                    default:
                        return Util.lf("Unsupported operator token in statement {0}", SK[n.operatorToken.kind]);
                }
            }
            else {
                return Util.lf("This expression cannot be assigned to")
            }
            return undefined;
        }

        function checkArrowFunction(n: ts.ArrowFunction, env: DecompilerEnv) {
            let fail = false;
            if (n.parameters.length) {
                let parent = getParent(n)[0];
                if (parent && pxtc.pxtInfo(parent).callInfo) {
                    let callInfo: pxtc.CallInfo = pxtc.pxtInfo(parent).callInfo;
                    if (env.attrs(callInfo).mutate === "objectdestructuring") {
                        fail = n.parameters[0].name.kind !== SK.ObjectBindingPattern
                    }
                    else {
                        fail = n.parameters.some(param => param.name.kind !== SK.Identifier);
                    }
                }
            }
            if (fail) {
                return Util.lf("Unsupported parameters in error function");
            }
            return undefined;
        }

        function checkIncrementorExpression(n: (ts.PrefixUnaryExpression | ts.PostfixUnaryExpression)) {
            if (n.operand.kind != SK.Identifier) {
                return Util.lf("-- and ++ may only be used on an identifier")
            }

            if (n.operator !== SK.PlusPlusToken && n.operator !== SK.MinusMinusToken) {
                return Util.lf("Only ++ and -- supported as prefix or postfix unary operators in a statement");
            }

            return undefined;
        }

        function checkVariableDeclaration(n: ts.VariableDeclaration, env: DecompilerEnv) {
            let check: string;

            if (n.name.kind !== SK.Identifier) {
                check = Util.lf("Variable declarations may not use binding patterns");
            }
            else if (!n.initializer) {
                check = Util.lf("Variable declarations must have an initializer");
            }
            else if (!isAutoDeclaration(n)) {
                check = checkExpression(n.initializer, env);
            }

            return check;
        }

        function checkVariableStatement(n: ts.VariableStatement, env: DecompilerEnv) {
            for (const declaration of n.declarationList.declarations) {
                const res = checkVariableDeclaration(declaration, env);
                if (res) {
                    return res;
                }
            }
            return undefined;
        }

        function checkCall(n: ts.CallExpression, env: DecompilerEnv, asExpression = false, topLevel = false) {
            const info: DecompilerCallInfo = pxtc.pxtInfo(n).callInfo;
            if (!info) {
                return Util.lf("Function call not supported in the blocks");
            }

            const attributes = env.attrs(info);

            let userFunction: FunctionDeclaration;

            if (ts.isIdentifier(n.expression)) {
                userFunction = env.declaredFunctions[unescapeVarName(n.expression.text)];
            }

            if (!asExpression) {
                if (info.isExpression && !userFunction) {
                    const alias = env.aliasBlocks[info.qName];

                    if (alias) {
                        info.decompilerBlockAlias = env.aliasBlocks[info.qName];
                    }
                    else {
                        return Util.lf("No output expressions as statements");
                    }
                }
            }

            if (info.qName == "Math.pow") {
                return undefined;
            }
            else if (pxt.Util.startsWith(info.qName, "Math.")) {
                const op = info.qName.substring(5);
                if (isSupportedMathFunction(op)) {
                    return undefined;
                }
            }

            if (attributes.blockId === pxtc.PAUSE_UNTIL_TYPE) {
                const predicate = n.arguments[0];
                if (n.arguments.length === 1 && checkPredicate(predicate)) {
                    return undefined;
                }
                return Util.lf("Predicates must be inline expressions that return a value");
            }

            const hasCallback = hasStatementInput(info, attributes);
            if (hasCallback && !attributes.handlerStatement && !topLevel) {
                return Util.lf("Events must be top level");
            }

            if (!attributes.blockId || !attributes.block) {
                const builtin = pxt.blocks.builtinFunctionInfo[info.qName];
                if (!builtin) {
                    if (!userFunction) {
                        return Util.lf("Call statements must have a valid declared function");
                    } else if (userFunction.parameters.length !== info.args.length) {
                        return Util.lf("Function calls in blocks must have the same number of arguments as the function definition");
                    } else {
                        return undefined;
                    }
                }
                attributes.blockId = builtin.blockId;
            }

            const args = paramList(info, env.blocks);
            const api = env.blocks.apis.byQName[info.qName];
            const comp = pxt.blocks.compileInfo(api);
            const totalDecompilableArgs = comp.parameters.length + (comp.thisParameter ? 1 : 0);

            if (attributes.imageLiteral) {
                // Image literals do not show up in the block string, so it won't be in comp
                if (info.args.length - totalDecompilableArgs > 1) {
                    return Util.lf("Function call has more arguments than are supported by its block");
                }

                let arg = n.arguments[0];
                if (arg.kind != SK.StringLiteral && arg.kind != SK.NoSubstitutionTemplateLiteral) {
                    return Util.lf("Only string literals supported for image literals")
                }
                const leds = ((arg as ts.StringLiteral).text || '').replace(/\s+/g, '');
                const nr = attributes.imageLiteralRows || 5;
                const nc = (attributes.imageLiteralColumns || 5) * attributes.imageLiteral;
                const nleds = nc * nr;
                if (nc * nr != leds.length) {
                    return Util.lf("Invalid image pattern ({0} expected vs {1} actual)", nleds, leds.length);
                }
                return undefined;
            }

            const argumentDifference = info.args.length - totalDecompilableArgs;

            if (argumentDifference > 0 && !checkForDestructuringMutation()) {
                let diff = argumentDifference;

                // Callbacks and default instance parameters do not appear in the block
                // definition string so they won't show up in the above count
                if (hasCallback) diff--;
                if (attributes.defaultInstance) diff--;

                if (diff > 0) {
                    return Util.lf("Function call has more arguments than are supported by its block");
                }
            }

            if (comp.parameters.length || hasCallback) {
                let fail: string;
                const instance = attributes.defaultInstance || !!comp.thisParameter;
                args.forEach((arg, i) => {
                    if (fail || instance && i === 0) {
                        return;
                    }
                    if (instance) i--;
                    fail = checkArgument(arg);
                });

                if (fail) {
                    return fail;
                }
            }

            if (api) {
                const ns = env.blocks.apis.byQName[api.namespace];
                if (ns && ns.attributes.fixedInstances && !ns.attributes.decompileIndirectFixedInstances && info.args.length) {
                    const callInfo: pxtc.CallInfo = pxtc.pxtInfo(info.args[0]).callInfo;
                    if (!callInfo || !env.attrs(callInfo).fixedInstance) {
                        return Util.lf("Fixed instance APIs can only be called directly from the fixed instance");
                    }
                }
            }

            return undefined;

            function checkForDestructuringMutation() {
                // If the mutatePropertyEnum is set, the array literal and the destructured
                // properties must have matching names
                if (attributes.mutatePropertyEnum && argumentDifference === 2 && info.args.length >= 2) {
                    const arrayArg = info.args[info.args.length - 2] as ArrayLiteralExpression;
                    const callbackArg = info.args[info.args.length - 1] as ArrowFunction;

                    if (arrayArg.kind === SK.ArrayLiteralExpression && isFunctionExpression(callbackArg)) {
                        const propNames: string[] = [];

                        // Make sure that all elements in the array literal are enum values
                        const allLiterals = !arrayArg.elements.some((e: PropertyAccessExpression) => {
                            if (e.kind === SK.PropertyAccessExpression && e.expression.kind === SK.Identifier) {
                                propNames.push(e.name.text);
                                return (e.expression as ts.Identifier).text !== attributes.mutatePropertyEnum;
                            }
                            return true;
                        });

                        if (allLiterals) {
                            // Also need to check that the array literal's values and the destructured values match
                            const bindings = getObjectBindingProperties(callbackArg);

                            if (bindings) {
                                const names = bindings[0];
                                return names.length === propNames.length && !propNames.some(p => names.indexOf(p) === -1);
                            }
                        }
                    }
                }
                return false;
            }

            function checkPredicate(p: ts.Node) {
                if (p.kind !== SK.FunctionExpression && p.kind !== SK.ArrowFunction) {
                    return false;
                }

                const predicate = p as (ts.FunctionExpression | ts.ArrowFunction);

                if (isOutputExpression(predicate.body as ts.Expression)) {
                    return true;
                }

                const body = predicate.body as ts.Block;
                if (body.statements.length === 1) {
                    const stmt = unwrapNode(body.statements[0]);
                    if (stmt.kind === SK.ReturnStatement) {
                        return true;
                    }
                }

                return false;
            }

            function checkArgument(arg: DecompileArgument) {
                const e = unwrapNode(arg.value) as Expression;
                const paramInfo = arg.info;
                const param = arg.param;

                if (paramInfo.isEnum) {
                    if (checkEnumArgument(e)) {
                        return undefined;
                    }
                    else if (e.kind === SK.CallExpression) {
                        const callInfo: pxtc.CallInfo = pxtc.pxtInfo(e).callInfo;
                        const attributes = env.attrs(callInfo);
                        if (callInfo && attributes.shim === "TD_ID" && callInfo.args && callInfo.args.length === 1) {
                            const arg = unwrapNode(callInfo.args[0]);
                            if (checkEnumArgument(arg)) {
                                return undefined;
                            }
                        }
                    }
                    else if (e.kind === SK.Identifier) {
                        const attributes = pxtInfo(e).commentAttrs;
                        if (attributes && attributes.enumIdentity) return undefined;
                    }
                    return Util.lf("Enum arguments may only be literal property access expressions");
                }
                else if (isLiteralNode(e) && (param.fieldEditor || param.shadowBlockId)) {
                    let dl: boolean = !!(param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileLiterals]);
                    if (!dl && param.shadowBlockId) {
                        const shadowInfo = env.blocks.blocksById[param.shadowBlockId];
                        if (shadowInfo && shadowInfo.parameters && shadowInfo.parameters.length) {
                            const name = shadowInfo.parameters[0].name;
                            if (shadowInfo.attributes.paramFieldEditorOptions && shadowInfo.attributes.paramFieldEditorOptions[name]) {
                                dl = !!(shadowInfo.attributes.paramFieldEditorOptions[name][DecompileParamKeys.DecompileLiterals]);
                            }
                            else {
                                dl = true;
                            }
                        }
                        else {
                            dl = true;
                        }
                    }
                    if (!dl) {
                        return Util.lf("Field editor does not support literal arguments");
                    }
                }
                else if (e.kind === SK.TaggedTemplateExpression && param.fieldEditor) {
                    let tagName = param.fieldOptions && param.fieldOptions[DecompileParamKeys.TaggedTemplate];

                    if (!tagName) {
                        return Util.lf("Tagged templates only supported in custom fields with param.fieldOptions.taggedTemplate set");
                    }

                    const tag = unwrapNode((e as ts.TaggedTemplateExpression).tag);

                    if (tag.kind !== SK.Identifier) {
                        return Util.lf("Tagged template literals must use an identifier as the tag");
                    }

                    const tagText = tag.getText();
                    if (tagText.trim() != tagName.trim()) {
                        return Util.lf("Function only supports template literals with tag '{0}'", tagName);
                    }

                    const template = (e as ts.TaggedTemplateExpression).template;

                    if (template.kind !== SK.NoSubstitutionTemplateLiteral) {
                        return Util.lf("Tagged template literals cannot have substitutions");
                    }
                }
                else if (e.kind === SK.ArrowFunction) {
                    const ar = e as ts.ArrowFunction;
                    if (ar.parameters.length) {
                        if (attributes.mutate === "objectdestructuring") {
                            const param = unwrapNode(ar.parameters[0]) as ts.ParameterDeclaration;
                            if (param.kind === SK.Parameter && param.name.kind !== SK.ObjectBindingPattern) {
                                return Util.lf("Object destructuring mutation callbacks can only have destructuring patters as arguments");
                            }
                        }
                        else {
                            for (const param of ar.parameters) {
                                if (param.name.kind !== SK.Identifier) {
                                    return Util.lf("Only identifiers allowed as function arguments");
                                }
                            }
                        }
                    }
                }
                else if (env.blocks.apis.byQName[paramInfo.type]) {
                    const typeInfo = env.blocks.apis.byQName[paramInfo.type];
                    if (typeInfo.attributes.fixedInstances) {
                        if (decompileFixedInst(param)) {
                            return undefined;
                        }
                        else if (param.shadowBlockId) {
                            const shadowSym = env.blocks.blocksById[param.shadowBlockId];
                            if (shadowSym) {
                                const shadowInfo = pxt.blocks.compileInfo(shadowSym);
                                if (shadowInfo.parameters && decompileFixedInst(shadowInfo.parameters[0])) {
                                    return undefined;
                                }
                            }
                        }

                        const callInfo = pxtc.pxtInfo(e).callInfo;

                        if (callInfo && env.attrs(callInfo).fixedInstance) {
                            return undefined;
                        }

                        return Util.lf("Arguments of a fixed instance type must be a reference to a fixed instance declaration");
                    }
                }

                return undefined;

                function checkEnumArgument(enumArg: ts.Node) {
                    // Enums can be under namespaces, so split up the qualified name into parts
                    const parts = paramInfo.type.split(".");

                    const enumParts: string[] = [];
                    while (enumArg.kind === SK.PropertyAccessExpression) {
                        enumParts.unshift((enumArg as PropertyAccessExpression).name.text);
                        enumArg = (enumArg as PropertyAccessExpression).expression;
                    }

                    if (enumArg.kind !== SK.Identifier) {
                        return false;
                    }

                    enumParts.unshift((enumArg as Identifier).text);

                    // Use parts.length, because enumParts also contains the enum member
                    for (let i = 0; i < parts.length; i++) {
                        if (parts[i] !== enumParts[i]) return false;
                    }

                    return true;
                }
            }
        }

        function checkFunctionDeclaration(n: ts.FunctionDeclaration, topLevel: boolean) {
            if (!topLevel) {
                return Util.lf("Function declarations must be top level");
            }

            if (n.parameters.length > 0) {
                if (env.opts.allowedArgumentTypes) {
                    for (const param of n.parameters) {
                        if (param.initializer || param.questionToken) {
                            return Util.lf("Function parameters cannot be optional");
                        }

                        const type = param.type ? param.type.getText() : undefined;
                        if (!type) {
                            return Util.lf("Function parameters must declare a type");
                        }

                        if (env.opts.allowedArgumentTypes.indexOf(normalizeType(type)) === -1) {
                            return Util.lf("Only types that can be added in blocks can be used for function arguments");
                        }
                    }
                }
            }

            return undefined;
        }

        function checkEnumDeclaration(n: ts.EnumDeclaration, topLevel: boolean) {
            if (!topLevel) return Util.lf("Enum declarations must be top level");

            const name = n.name.text;
            const info = env.blocks.enumsByName[name];
            if (!info) return Util.lf("Enum declarations in user code must have a block")

            let fail = false;

            // Initializers can either be a numeric literal or of the form a << b
            n.members.forEach(member => {
                if (member.name.kind !== SK.Identifier) fail = true;
                if (fail) return;
                if (member.initializer) {
                    if (member.initializer.kind === SK.NumericLiteral) {
                        return;
                    }
                    else if (member.initializer.kind === SK.BinaryExpression) {
                        const ex = member.initializer as BinaryExpression;
                        if (ex.operatorToken.kind === SK.LessThanLessThanToken) {
                            if (ex.left.kind === SK.NumericLiteral && ex.right.kind === SK.NumericLiteral) {
                                if ((ex.left as NumericLiteral).text == "1") {
                                    return;
                                }
                            }
                        }
                    }
                    fail = true;
                }
            });

            if (fail) {
                return Util.lf("Invalid initializer for enum member")
            }

            return undefined;
        }

        function checkNamespaceDeclaration(n: ts.NamespaceDeclaration) {
            const kindCheck = checkKindNamespaceDeclaration(n, env);
            if (!kindCheck) return undefined;

            const tilesetCheck = checkTilesetNamespace(n);
            if (!tilesetCheck) return undefined;

            return kindCheck;
        }

        function checkReturnStatement(n: ts.ReturnStatement) {
            if (checkIfWithinFunction(n)) {
                return undefined;
            }
            return Util.lf("Return statements can only be used within top-level function declarations");

            function checkIfWithinFunction(n: Node): boolean {
                const enclosing = ts.getEnclosingBlockScopeContainer(n);
                if (enclosing) {
                    switch (enclosing.kind) {
                        case SK.SourceFile:
                        case SK.ArrowFunction:
                        case SK.FunctionExpression:
                            return false;
                        case SK.FunctionDeclaration:
                            return enclosing.parent && enclosing.parent.kind === SK.SourceFile && !checkStatement(enclosing, env, false, true);
                        default:
                            return checkIfWithinFunction(enclosing);
                    }
                }

                return false;
            }
        }
    }

    function checkKindNamespaceDeclaration(n: ts.NamespaceDeclaration, env: DecompilerEnv) {
        if (!isModuleBlock(n.body)) {
            return Util.lf("Namespaces cannot be nested.")
        }

        const kindInfo = env.blocks.kindsByName[n.name.text]
        if (!kindInfo) {
            return Util.lf("Only namespaces with 'kind' blocks can be decompiled");
        }

        const fail = Util.lf("Namespaces may only contain valid 'kind' exports");

        // Each statement must be of the form `export const kind = kindNamespace.create()`
        for (const statement of n.body.statements) {
            // There isn't really a way to persist comments, so to be safe just bail out
            if (isCommented(statement)) return fail;

            if (isVariableStatement(statement) && statement.declarationList.declarations) {
                const isSingleDeclaration = statement.declarationList.declarations.length === 1;
                const isExport = statement.modifiers && statement.modifiers.length === 1 && statement.modifiers[0].kind === SK.ExportKeyword;
                const isConst = statement.declarationList.flags & NodeFlags.Const

                if (isSingleDeclaration && isExport && isConst) {
                    const declaration = statement.declarationList.declarations[0];
                    if (!declaration.initializer || !isCallExpression(declaration.initializer) || !isIdentifier(declaration.name)) {
                        return fail;
                    }

                    const call = declaration.initializer;

                    if (call.arguments.length) {
                        return fail;
                    }

                    // The namespace is emitted from the blocks, but it's optional when decompiling
                    if (isPropertyAccessExpression(call.expression) && isIdentifier(call.expression.expression)) {
                        if (call.expression.expression.text !== kindInfo.name || call.expression.name.text !== kindInfo.createFunctionName) return fail;
                    }
                    else if (isIdentifier(call.expression)) {
                        if (call.expression.text !== kindInfo.createFunctionName) return fail;
                    }
                    else {
                        return fail;
                    }
                }
                else {
                    return fail;
                }
            }
            else {
                return fail;
            }
        }

        return undefined;
    }

    function checkTilesetNamespace(n: ts.NamespaceDeclaration) {
        if (!isModuleBlock(n.body)) {
            return Util.lf("Namespaces cannot be nested.")
        }

        if (n.name.text !== pxt.sprite.TILE_NAMESPACE) {
            return Util.lf("Tileset namespace must be named myTiles");
        }

        const fail = Util.lf("The myTiles namespace can only export tile variables with image literal initializers and no duplicate ids");
        const commentFail = Util.lf("Tileset members must have a blockIdentity comment and no other annotations");

        const nameRegex = new RegExp(`${pxt.sprite.TILE_PREFIX}(\\d+)`);
        const foundIds: string[] = [];

        const commentRegex = /^\s*\/\/%\s*blockIdentity=[^\s]+\s*$/;

        // Each statement must be of the form "export const tile{ID} = img``;"
        for (const statement of (n.body as ts.ModuleBlock).statements) {
            // Tile members have a single annotation of the form "//% blockIdentity=..."
            // Bail out on any other comment because we can't persist it
            const commentRanges = ts.getLeadingCommentRangesOfNode(statement, statement.getSourceFile());

            if (commentRanges && commentRanges.length) {
                const comments = commentRanges.map(cr => statement.getSourceFile().text.substr(cr.pos, cr.end - cr.pos)).filter(c => !!c);

                if (comments.length !== 1 || !commentRegex.test(comments[0])) {
                    return commentFail;
                }
            }
            else {
                return commentFail;
            }

            if (isVariableStatement(statement) && statement.declarationList.declarations) {
                const isSingleDeclaration = statement.declarationList.declarations.length === 1;
                const isExport = statement.modifiers && statement.modifiers.length === 1 && statement.modifiers[0].kind === SK.ExportKeyword;
                const isConst = statement.declarationList.flags & NodeFlags.Const

                if (isSingleDeclaration && isExport && isConst) {
                    const declaration = statement.declarationList.declarations[0];
                    if (!declaration.initializer || !isTaggedTemplateExpression(declaration.initializer) || !isIdentifier(declaration.name)) {
                        return fail;
                    }

                    const tag = declaration.initializer;

                    if (!isIdentifier(tag.tag) || tag.tag.text !== "img") {
                        return fail;
                    }

                    const match = nameRegex.exec(declaration.name.text);

                    if (!match || foundIds.indexOf(match[1]) !== -1) {
                        return fail;
                    }

                    foundIds.push(match[1]);
                }
                else {
                    return fail;
                }
            }
            else {
                return fail;
            }
        }

        return undefined;
    }

    function isEmptyStringNode(node: Node) {
        if (node.kind === SK.StringLiteral || node.kind === SK.NoSubstitutionTemplateLiteral) {
            return (node as LiteralLikeNode).text === "";
        }
        return false;
    }

    function isAutoDeclaration(decl: VariableDeclaration) {
        if (decl.initializer) {
            if (decl.initializer.kind === SyntaxKind.NullKeyword || decl.initializer.kind === SyntaxKind.FalseKeyword || isDefaultArray(decl.initializer)) {
                return true
            }
            else if (isStringOrNumericLiteral(decl.initializer)) {
                const text = decl.initializer.getText();
                return text === "0" || isEmptyString(text);
            }
            else {
                const callInfo: pxtc.CallInfo = pxtc.pxtInfo(decl.initializer).callInfo
                if (callInfo && callInfo.isAutoCreate)
                    return true
            }
        }
        return false;
    }

    function isDefaultArray(e: Expression) {
        return e.kind === SK.ArrayLiteralExpression && (e as ArrayLiteralExpression).elements.length === 0;
    }

    function getObjectBindingProperties(callback: ts.ArrowFunction): [string[], pxt.Map<string>] {
        if (callback.parameters.length === 1 && callback.parameters[0].name.kind === SK.ObjectBindingPattern) {
            const elements = (callback.parameters[0].name as ObjectBindingPattern).elements;

            const renames: { [index: string]: string } = {};

            const properties = elements.map(e => {
                if (checkName(e.propertyName) && checkName(e.name)) {
                    const name = (e.name as Identifier).text;
                    if (e.propertyName) {
                        const propName = (e.propertyName as Identifier).text;
                        renames[propName] = name;
                        return propName;
                    }
                    return name;
                }
                else {
                    return "";
                }
            });

            return [properties, renames];
        }

        return undefined;

        function checkName(name: Node) {
            if (name && name.kind !== SK.Identifier) {
                // error(name, Util.lf("Only identifiers may be used for variable names in object destructuring patterns"));
                return false;
            }
            return true;
        }
    }

    function checkExpression(n: ts.Node, env: DecompilerEnv): string {
        switch (n.kind) {
            case SK.NumericLiteral:
            case SK.TrueKeyword:
            case SK.FalseKeyword:
            case SK.ExpressionStatement:
            case SK.ArrayLiteralExpression:
            case SK.ElementAccessExpression:
                return undefined;
            case SK.ParenthesizedExpression:
                return checkExpression((n as ts.ParenthesizedExpression).expression, env);
            case SK.StringLiteral:
            case SK.FirstTemplateToken:
            case SK.NoSubstitutionTemplateLiteral:
                return checkStringLiteral(n as ts.StringLiteral);
            case SK.Identifier:
                const pInfo = pxtInfo(n);
                if (isUndefined(n)) {
                    return Util.lf("Undefined is not supported in blocks");
                } else if (isDeclaredElsewhere(n as Identifier) && !(pInfo.commentAttrs && pInfo.commentAttrs.blockIdentity && pInfo.commentAttrs.enumIdentity)) {
                    return Util.lf("Variable is declared in another file");
                } else {
                    return undefined;
                }
            case SK.BinaryExpression:
                const op1 = (n as BinaryExpression).operatorToken.getText();
                return ops[op1] ? undefined : Util.lf("Could not find operator {0}", op1);
            case SK.PrefixUnaryExpression:
                const op2 = (n as PrefixUnaryExpression).operator;
                return op2 === SK.MinusToken || op2 === SK.PlusToken || op2 === SK.ExclamationToken ?
                    undefined : Util.lf("Unsupported prefix unary operator{0}", op2);
            case SK.PropertyAccessExpression:
                return checkPropertyAccessExpression(n as ts.PropertyAccessExpression, env);
            case SK.CallExpression:
                return checkStatement(n, env, true, undefined);
            case SK.TaggedTemplateExpression:
                return checkTaggedTemplateExpression(n as ts.TaggedTemplateExpression, env);

        }
        return Util.lf("Unsupported syntax kind for output expression block: {0}", SK[n.kind]);

        function checkStringLiteral(n: ts.StringLiteral) {
            const literal = n.text;
            return validStringRegex.test(literal) ? undefined : Util.lf("Only whitespace character allowed in string literals is space");
        }

        function checkPropertyAccessExpression(n: ts.PropertyAccessExpression, env: DecompilerEnv) {
            const callInfo: pxtc.CallInfo = pxtc.pxtInfo(n).callInfo;
            if (callInfo) {
                const attributes = env.attrs(callInfo);
                const blockInfo = env.compInfo(callInfo);
                if (attributes.blockIdentity || attributes.blockId === "lists_length" || attributes.blockId === "text_length") {
                    return undefined;
                }
                else if (callInfo.decl.kind === SK.EnumMember) {
                    // Check to see if this an enum with a block
                    if (n.expression.kind === SK.Identifier) {
                        const enumName = (n.expression as ts.Identifier).text;
                        if (env.declaredEnums[enumName]) return undefined;
                    }

                    // Otherwise make sure this is in a dropdown on the block
                    const [parent, child] = getParent(n);
                    let fail = true;

                    if (parent) {
                        const parentInfo: pxtc.CallInfo = pxtc.pxtInfo(parent).callInfo;
                        if (parentInfo && parentInfo.args) {
                            const api = env.blocks.apis.byQName[parentInfo.qName];
                            const instance = api.kind == pxtc.SymbolKind.Method || api.kind == pxtc.SymbolKind.Property;
                            if (api) {
                                parentInfo.args.forEach((arg, i) => {
                                    if (arg === child) {
                                        const paramInfo = api.parameters[instance ? i - 1 : i];
                                        if (paramInfo.isEnum) {
                                            fail = false;
                                        }
                                    }
                                });
                            }
                        }
                    }

                    if (fail) {
                        return Util.lf("Enum value without a corresponding block");
                    }
                    else {
                        return undefined;
                    }
                }
                else if (attributes.fixedInstance && n.parent) {
                    // Check if this is a fixedInstance with a method being called on it
                    if (n.parent.parent && n.parent.kind === SK.PropertyAccessExpression && n.parent.parent.kind === SK.CallExpression) {
                        const call = n.parent.parent as CallExpression;
                        if (call.expression === n.parent) {
                            return undefined;
                        }
                    }
                    // Check if this fixedInstance is an argument passed to a function
                    else if (n.parent.kind === SK.CallExpression && (n.parent as CallExpression).expression !== n) {
                        return undefined;
                    }
                }
                else if (attributes.blockCombine || (attributes.blockId && blockInfo && blockInfo.thisParameter)) {
                    // block combine and getters/setters
                    return checkExpression(n.expression, env)
                }
                else if (isIdentifier(n.expression) && env.declaredKinds[n.expression.text]) {
                    const propName = n.name.text;
                    const kind = env.declaredKinds[n.expression.text];

                    if (kind && (kind.kindInfo.initialMembers.indexOf(propName) !== -1 || kind.declaredNames.indexOf(propName) !== -1)) {
                        return undefined;
                    }
                }
            }
            return Util.lf("No call info found");
        }
    }

    function checkTaggedTemplateExpression(t: ts.TaggedTemplateExpression, env: DecompilerEnv) {
        const callInfo: pxtc.CallInfo = pxtc.pxtInfo(t).callInfo;

        if (!callInfo) {
            return Util.lf("Invalid tagged template");
        }

        const attributes = env.attrs(callInfo);

        if (!attributes.blockIdentity) {
            return Util.lf("Tagged template does not have blockIdentity set");
        }

        const api = env.blocks.apis.byQName[attributes.blockIdentity];

        if (!api) {
            return Util.lf("Could not find blockIdentity for tagged template")
        }

        const comp = pxt.blocks.compileInfo(api);
        if (comp.parameters.length !== 1) {
            return Util.lf("Tagged template functions must have 1 argument");
        }

        // The compiler will have already caught any invalid tags or templates
        return undefined;
    }

    function getParent(node: Node): [Node, Node] {
        if (!node.parent) {
            return [undefined, node];
        }
        else if (node.parent.kind === SK.ParenthesizedExpression) {
            return getParent(node.parent);
        }
        else {
            return [node.parent, node];
        }
    }

    function unwrapNode(node: Node) {
        while (node.kind === SK.ParenthesizedExpression) {
            node = (node as ParenthesizedExpression).expression;
        }
        return node;
    }

    function isEmptyString(a: string) {
        return a === `""` || a === `''` || a === "``";
    }

    function isUndefined(node: ts.Node) {
        return node && node.kind === SK.Identifier && (node as ts.Identifier).text === "undefined";
    }

    function isDeclaredElsewhere(node: ts.Identifier) {
        return !!(pxtInfo(node).flags & PxtNodeFlags.IsGlobalIdentifier)
    }

    function hasStatementInput(info: CallInfo, attributes: CommentAttrs): boolean {
        if (attributes.blockId === pxtc.PAUSE_UNTIL_TYPE) return false;
        const parameters = (info.decl as FunctionLikeDeclaration).parameters;
        return info.args.some((arg, index) => arg && isFunctionExpression(arg));
    }

    function isLiteralNode(node: ts.Node): boolean {
        if (!node) {
            return false
        }
        switch (node.kind) {
            case SK.ParenthesizedExpression:
                return isLiteralNode((node as ts.ParenthesizedExpression).expression)
            case SK.ArrayLiteralExpression:
                const arr = node as ts.ArrayLiteralExpression;

                // Check to make sure all array elements are literals or tagged template literals (e.g. img``)
                for (const el of arr.elements) {
                    if (!isLiteralNode(el) && el.kind !== SK.TaggedTemplateExpression) {
                        return false;
                    }
                }
                return true;
            case SK.NumericLiteral:
            case SK.StringLiteral:
            case SK.NoSubstitutionTemplateLiteral:
            case SK.TrueKeyword:
            case SK.FalseKeyword:
                return true
            case SK.PrefixUnaryExpression:
                const expression = (node as ts.PrefixUnaryExpression)
                return (expression.operator === SK.PlusToken || expression.operator === SK.MinusToken) && isLiteralNode(expression.operand)
            default:
                return false;
        }
    }

    function unescapeVarName(name: string) {
        return name.replace(
            /E([0-9a-f]{4,6})X/g,
            s => String.fromCodePoint(+`0x${s.slice(1, s.length - 1)}`)
        );
    }

    function isFunctionExpression(node: Node) {
        return node.kind === SK.ArrowFunction || node.kind === SK.FunctionExpression;
    }

    function paramList(info: CallInfo, blocksInfo: BlocksInfo) {
        const res: DecompileArgument[] = [];
        const sym = blocksInfo.apis.byQName[info.qName];

        if (sym) {
            const attributes = blocksInfo.apis.byQName[info.qName].attributes;
            const comp = pxt.blocks.compileInfo(sym);
            const builtin = pxt.blocks.builtinFunctionInfo[info.qName]
            let offset = attributes.imageLiteral ? 1 : 0;

            if (comp.thisParameter) {
                res.push({
                    value: unwrapNode(info.args[0]) as Expression,
                    info: null,
                    param: comp.thisParameter
                });
            }
            else if (attributes.defaultInstance) {
                res.push({
                    value: unwrapNode(info.args[0]) as Expression,
                    info: sym.parameters[0],
                    param: { definitionName: "__instance__", actualName: "this" }
                });
            }

            const hasThisArgInSymbol = !!(comp.thisParameter || attributes.defaultInstance);
            if (hasThisArgInSymbol) {
                offset++;
            }

            for (let i = offset; i < info.args.length; i++) {
                res.push({
                    value: unwrapNode(info.args[i]) as Expression,
                    info: sym.parameters[hasThisArgInSymbol ? i - 1 : i],
                    param: comp.parameters[i - offset]
                });
            }
        }

        return res;
    }

    // This assumes the enum already passed checkEnumDeclaration
    function getEnumMembers(n: EnumDeclaration): [string, number][] {
        const res: [string, number][] = [];

        n.members.forEach(member => {
            U.assert(member.name.kind === SK.Identifier);
            const name = (member.name as ts.Identifier).text;
            let value: number;
            if (member.initializer) {
                if (member.initializer.kind === SK.NumericLiteral) {
                    value = parseInt((member.initializer as NumericLiteral).text);
                }
                else {
                    const ex = member.initializer as BinaryExpression;

                    U.assert(ex.left.kind === SK.NumericLiteral);
                    U.assert((ex.left as NumericLiteral).text === "1");
                    U.assert(ex.operatorToken.kind === SK.LessThanLessThanToken);
                    U.assert(ex.right.kind === SK.NumericLiteral);

                    const shift = parseInt((ex.right as ts.NumericLiteral).text);
                    value = 1 << shift;
                }
            }
            else if (res.length === 0) {
                value = 0;
            }
            else {
                value = res[res.length - 1][1] + 1
            }

            res.push([name, value]);
        });

        return res;
    }

    function getModuleExports(n: ModuleDeclaration): DecompileModuleExport[] {
        return (n.body as ModuleBlock).statements.map(s => {
            const decl = (s as VariableStatement).declarationList.declarations[0];

            return {
                name: (decl.name as ts.Identifier).text,
                initializer: decl.initializer.getText()
            };
        });
    }

    function isOutputExpression(expr: ts.Expression): boolean {
        switch (expr.kind) {
            case SK.BinaryExpression:
                const tk = (expr as ts.BinaryExpression).operatorToken.kind;
                return tk != SK.PlusEqualsToken && tk != SK.MinusEqualsToken && tk != SK.EqualsToken;
            case SK.PrefixUnaryExpression: {
                let op = (expr as ts.PrefixUnaryExpression).operator;
                return op != SK.PlusPlusToken && op != SK.MinusMinusToken;
            }
            case SK.PostfixUnaryExpression: {
                let op = (expr as ts.PostfixUnaryExpression).operator;
                return op != SK.PlusPlusToken && op != SK.MinusMinusToken;
            }
            case SK.CallExpression:
                const callInfo: pxtc.CallInfo = pxtc.pxtInfo(expr).callInfo
                assert(!!callInfo);
                return callInfo.isExpression;
            case SK.ParenthesizedExpression:
            case SK.NumericLiteral:
            case SK.StringLiteral:
            case SK.NoSubstitutionTemplateLiteral:
            case SK.TrueKeyword:
            case SK.FalseKeyword:
            case SK.NullKeyword:
            case SK.TaggedTemplateExpression:
                return true;
            default: return false;
        }
    }

    function isLiteralBlockType(type: string) {
        switch (type) {
            case numberType:
            case minmaxNumberType:
            case integerNumberType:
            case wholeNumberType:
            case stringType:
            case booleanType:
                return true;
            default:
                return false;
        }
    }

    function decompileFixedInst(param: pxt.blocks.BlockParameter) {
        return param && param.fieldOptions && param.fieldOptions[DecompileParamKeys.DecompileIndirectFixedInstances];
    }

    function isSupportedMathFunction(op: string) {
        return isUnaryMathFunction(op) || isInfixMathFunction(op) || isRoundingFunction(op) ||
            pxt.blocks.MATH_FUNCTIONS.binary.indexOf(op) !== -1;
    }

    function isUnaryMathFunction(op: string) {
        return pxt.blocks.MATH_FUNCTIONS.unary.indexOf(op) !== -1
    }

    function isInfixMathFunction(op: string) {
        return pxt.blocks.MATH_FUNCTIONS.infix.indexOf(op) !== -1;
    }

    function isRoundingFunction(op: string) {
        return pxt.blocks.ROUNDING_FUNCTIONS.indexOf(op) !== -1;
    }

    function normalizeType(type: string) {
        const match = arrayTypeRegex.exec(type);
        if (match) {
            return `${match[1] || match[2]}[]`
        }
        return type;
    }

    function isCommented(node: ts.Node) {
        const ranges = ts.getLeadingCommentRangesOfNode(node, node.getSourceFile());
        return !!(ranges && ranges.length)
    }

    function getCommentsFromRanges(file: ts.SourceFile, commentRanges: ts.CommentRange[], isTrailingComment = false) {
        const res: Comment[] = [];
        const fileText = file.getFullText();

        if (commentRanges && commentRanges.length) {
            for (const commentRange of commentRanges) {

                const endLine = ts.getLineOfLocalPosition(file, commentRange.end);
                const nextLineStart = ts.getStartPositionOfLine(endLine + 1, file) || fileText.length;
                const nextLineEnd = ts.getStartPositionOfLine(endLine + 2, file) || fileText.length;

                const followedByEmptyLine = !isTrailingComment && !fileText.substr(
                    nextLineStart,
                    nextLineEnd - nextLineStart
                ).trim();

                let commentText = fileText.substr(commentRange.pos, commentRange.end - commentRange.pos)
                if (commentText) {
                    // Strip windows line endings because they break the regex we use to extract content
                    commentText = commentText.replace(/\r\n/g, "\n");
                }
                if (commentRange.kind === SyntaxKind.SingleLineCommentTrivia) {
                    const match = singleLineCommentRegex.exec(commentText);

                    if (match) {
                        res.push({
                            kind: CommentKind.SingleLine,
                            text: match[1],
                            start: commentRange.pos,
                            end: commentRange.end,
                            hasTrailingNewline: !!commentRange.hasTrailingNewLine,
                            followedByEmptyLine,
                            isTrailingComment
                        });
                    }
                    else {
                        res.push({
                            kind: CommentKind.SingleLine,
                            text: "",
                            start: commentRange.pos,
                            end: commentRange.end,
                            hasTrailingNewline: !!commentRange.hasTrailingNewLine,
                            followedByEmptyLine,
                            isTrailingComment
                        });
                    }
                }
                else {
                    const lines = commentText.split("\n").map(line => {
                        const match = multiLineCommentRegex.exec(line);
                        return match ? match[1] : "";
                    });
                    res.push({
                        kind: CommentKind.MultiLine,
                        lines,
                        start: commentRange.pos,
                        end: commentRange.end,
                        hasTrailingNewline: !!commentRange.hasTrailingNewLine,
                        followedByEmptyLine,
                        isTrailingComment
                    });
                }
            }
        }

        return res;
    }

    function formatCommentsForBlocks(comments: Comment[]) {
        let out = "";

        for (const comment of comments) {
            if (comment.kind === CommentKind.SingleLine) {
                if (comment.text === ON_START_COMMENT || comment.text === HANDLER_COMMENT) {
                    continue;
                }
                else {
                    out += comment.text.trim() + "\n";
                }
            }
            else {
                for (const line of comment.lines) {
                    out += line.trim() + "\n";
                }
            }
        }

        return out.trim();
    }

    function isTopLevelComment(n: Node): boolean {
        const [parent,] = getParent(n);
        if (!parent || parent.kind == SK.SourceFile) return true;
        // Expression statement
        if (parent.kind == SK.ExpressionStatement) return isTopLevelComment(parent);
        // Variable statement
        if (parent.kind == SK.VariableDeclarationList) return isTopLevelComment(parent.parent);
        return false;
    }

    export function getLeadingComments(node: Node, file: ts.SourceFile, commentRanges?: ts.CommentRange[]): Comment[] {
        return getCommentsFromRanges(file, commentRanges || ts.getLeadingCommentRangesOfNode(node, file));
    }

    export function getTrailingComments(node: Node, file: ts.SourceFile): Comment[] {
        return getCommentsFromRanges(file, ts.getTrailingCommentRanges(file.getFullText(), node.end));
    }

    export function getCommentsForStatement(commented: Node, commentMap: Comment[]) {
        let comments: Comment[] = [];
        let current: Comment;
        for (let i = 0; i < commentMap.length; i++) {
            current = commentMap[i];
            if (!current.owner && current.start >= commented.pos && current.end <= commented.end) {
                current.owner = commented;
                comments.push(current);
            }

            if (current.start > commented.end) break;
        }

        return comments;
    }

    export function buildCommentMap(file: SourceFile) {
        const fileText = file.getFullText();
        const scanner = ts.createScanner(file.languageVersion, false, file.languageVariant, fileText, undefined, file.getFullStart());
        let res: Comment[] = [];

        let leading: CommentRange[];
        let trailing: CommentRange[];

        while (scanner.getTextPos() < file.end) {
            const val = scanner.scan();
            if (val === SK.SingleLineCommentTrivia || val === SK.MultiLineCommentTrivia) {
                leading = ts.getLeadingCommentRanges(fileText, scanner.getTokenPos()) || [];
                trailing = ts.getTrailingCommentRanges(fileText, scanner.getTokenPos()) || [];

                // Filter out duplicates
                trailing = trailing.filter(range => !leading.some(other => other.pos === range.pos));

                res.push(...getCommentsFromRanges(file, leading, false));
                res.push(...getCommentsFromRanges(file, trailing, true));

                for (const range of res) {
                    if (range.end > scanner.getTextPos()) {
                        scanner.setTextPos(range.end)
                    }
                }
            }
        }

        res.sort((a, b) => a.start - b.start);

        return res;
    }

    function markCommentsInRange(node: Node, commentMap: Comment[]) {
        let current: Comment;
        for (let i = 0; i < commentMap.length; i++) {
            current = commentMap[i];
            if (!current.owner && current.start >= node.pos && current.end <= node.end) {
                current.owner = node;
            }
        }
    }
}
