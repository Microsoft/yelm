// TODO: enable reference so we don't need to use: (pxt as any).py
//      the issue is that this creates a circular dependency. This
//      is easily handled if we used proper TS modules.
//// <reference path="../../built/pxtpy.d.ts"/>

namespace ts.pxtc {

    export const placeholderChar = "◊";
    export const defaultImgLit = `
. . . . .
. . . . .
. . # . .
. . . . .
. . . . .
`

    export interface FunOverride {
        n: string;
        t: any;
        scale?: number;
        snippet?: string;
    }

    export const ts2PyFunNameMap: pxt.Map<FunOverride> = {
        "Math.trunc": { n: "int", t: ts.SyntaxKind.NumberKeyword, snippet: "int(0)" },
        "Math.min": { n: "min", t: ts.SyntaxKind.NumberKeyword, snippet: "min(0, 0)" },
        "Math.max": { n: "max", t: ts.SyntaxKind.NumberKeyword, snippet: "max(0, 0)" },
        "Math.abs": { n: "abs", t: ts.SyntaxKind.NumberKeyword, snippet: "abs(0)" },
        "Math.randomRange": { n: "randint", t: ts.SyntaxKind.NumberKeyword, snippet: "randint(0, 10)" },
        "console.log": { n: "print", t: ts.SyntaxKind.VoidKeyword, snippet: 'print(":)")' },
        ".length": { n: "len", t: ts.SyntaxKind.NumberKeyword },
        ".toLowerCase()": { n: "string.lower", t: ts.SyntaxKind.StringKeyword },
        ".toUpperCase()": { n: "string.upper", t: ts.SyntaxKind.StringKeyword },
        ".charCodeAt(0)": { n: "ord", t: ts.SyntaxKind.NumberKeyword },
        "pins.createBuffer": { n: "bytearray", t: ts.SyntaxKind.Unknown },
        "pins.createBufferFromArray": { n: "bytes", t: ts.SyntaxKind.Unknown },
        "control.createBuffer": { n: "bytearray", t: ts.SyntaxKind.Unknown },
        "control.createBufferFromArray": { n: "bytes", t: ts.SyntaxKind.Unknown },
        "!!": { n: "bool", t: ts.SyntaxKind.BooleanKeyword },
        ".indexOf": { n: "Array.index", t: ts.SyntaxKind.NumberKeyword },
        "parseInt": { n: "int", t: ts.SyntaxKind.NumberKeyword, snippet: 'int("0")' }
    }

    function renderDefaultVal(apis: pxtc.ApisInfo, p: pxtc.ParameterDesc, imgLit: boolean, cursorMarker: string): string {
        if (p.initializer) return p.initializer
        if (p.default) return p.default
        if (p.type == "number") return "0"
        if (p.type == "boolean") return "false"
        else if (p.type == "string") {
            if (imgLit) {
                imgLit = false
                return "`" + defaultImgLit + cursorMarker + "`";
            }
            return `"${cursorMarker}"`
        }
        let si = apis ? Util.lookup(apis.byQName, p.type) : undefined;
        if (si && si.kind == SymbolKind.Enum) {
            let en = Util.values(apis.byQName).filter(e => e.namespace == p.type)[0]
            if (en)
                return en.namespace + "." + en.name;
        }
        let m = /^\((.*)\) => (.*)$/.exec(p.type)
        if (m)
            return `(${m[1]}) => {\n    ${cursorMarker}\n}`
        return placeholderChar;
    }

    export function renderCall(apiInfo: pxtc.ApisInfo, si: SymbolInfo): string {
        return `${si.namespace}.${si.name}${renderParameters(apiInfo, si)};`;
    }

    export function renderParameters(apis: pxtc.ApisInfo, si: SymbolInfo, cursorMarker: string = ''): string {
        if (si.parameters) {
            let imgLit = !!si.attributes.imageLiteral
            return "(" + si.parameters
                .filter(p => !p.initializer)
                .map(p => renderDefaultVal(apis, p, imgLit, cursorMarker)).join(", ") + ")"
        }
        return '';
    }

    export function snakify(s: string) {
        const up = s.toUpperCase()
        const lo = s.toLowerCase()

        // if the name is all lowercase or all upper case don't do anything
        if (s == up || s == lo)
            return s

        // if the name already has underscores (not as first character), leave it alone
        if (s.lastIndexOf("_") > 0)
            return s

        const isUpper = (i: number) => s[i] != lo[i]
        const isLower = (i: number) => s[i] != up[i]
        //const isDigit = (i: number) => /\d/.test(s[i])

        let r = ""
        let i = 0
        while (i < s.length) {
            let upperMode = isUpper(i)
            let j = i
            while (j < s.length) {
                if (upperMode && isLower(j)) {
                    // ABCd -> AB_Cd
                    if (j - i > 2) {
                        j--
                        break
                    } else {
                        // ABdefQ -> ABdef_Q
                        upperMode = false
                    }
                }
                // abcdE -> abcd_E
                if (!upperMode && isUpper(j)) {
                    break
                }
                j++
            }
            if (r) r += "_"
            r += s.slice(i, j)
            i = j
        }

        // If the name is is all caps (like a constant), preserve it
        if (r.toUpperCase() === r) {
            return r;
        }
        return r.toLowerCase();
    }

    export function emitType(s: ts.TypeNode): string {
        if (!s || !s.kind) return null;
        switch (s.kind) {
            case ts.SyntaxKind.StringKeyword:
                return "str"
            case ts.SyntaxKind.NumberKeyword:
                // Note, "real" python expects this to be "float" or "int", we're intentionally diverging here
                return "number"
            case ts.SyntaxKind.BooleanKeyword:
                return "bool"
            case ts.SyntaxKind.VoidKeyword:
                return "None"
            case ts.SyntaxKind.FunctionType:
                return emitFuncType(s as ts.FunctionTypeNode)
            case ts.SyntaxKind.ArrayType: {
                let t = s as ts.ArrayTypeNode
                let elType = emitType(t.elementType)
                return `List[${elType}]`
            }
            case ts.SyntaxKind.TypeReference: {
                let t = s as ts.TypeReferenceNode
                let nm = t.typeName && t.typeName.getText ? t.typeName.getText() : t.typeName;
                return `${nm}`
            }
            case ts.SyntaxKind.AnyKeyword:
                return "any"
            default:
                pxt.tickEvent("depython.todo", { kind: s.kind })
                return ``
        }
        // // TODO translate type
        // return s.getText()
    }

    function emitFuncType(s: ts.FunctionTypeNode): string {
        let returnType = emitType(s.type)
        let params = s.parameters
            .map(p => p.type) // python type syntax doesn't allow names
            .map(emitType)

        // "Real" python expects this to be "Callable[[arg1, arg2], ret]", we're intentionally changing to "(arg1, arg2) -> ret"
        return `(${params.join(", ")}) -> ${returnType}`
    }

    function getSymbolKind(node: Node) {
        switch (node.kind) {
            case SK.MethodDeclaration:
            case SK.MethodSignature:
                return SymbolKind.Method;
            case SK.PropertyDeclaration:
            case SK.PropertySignature:
            case SK.GetAccessor:
            case SK.SetAccessor:
                return SymbolKind.Property;
            case SK.Constructor:
            case SK.FunctionDeclaration:
                return SymbolKind.Function;
            case SK.VariableDeclaration:
                return SymbolKind.Variable;
            case SK.ModuleDeclaration:
                return SymbolKind.Module;
            case SK.EnumDeclaration:
                return SymbolKind.Enum;
            case SK.EnumMember:
                return SymbolKind.EnumMember;
            case SK.ClassDeclaration:
                return SymbolKind.Class;
            case SK.InterfaceDeclaration:
                return SymbolKind.Interface;
            default:
                return SymbolKind.None
        }
    }

    function isExported(decl: Declaration) {
        if (decl.modifiers && decl.modifiers.some(m => m.kind == SK.PrivateKeyword || m.kind == SK.ProtectedKeyword))
            return false;

        let symbol = decl.symbol

        if (!symbol)
            return false;

        while (true) {
            let parSymbol: Symbol = (symbol as any).parent
            if (parSymbol) symbol = parSymbol
            else break
        }

        let topDecl = symbol.valueDeclaration || symbol.declarations[0]

        if (topDecl.kind == SK.VariableDeclaration)
            topDecl = topDecl.parent.parent as Declaration

        if (topDecl.parent && topDecl.parent.kind == SK.SourceFile)
            return true;
        else
            return false;
    }

    function isReadonly(decl: Declaration) {
        return decl.modifiers && decl.modifiers.some(m => m.kind == SK.ReadonlyKeyword)
    }

    function createSymbolInfo(typechecker: TypeChecker, qName: string, stmt: Node): SymbolInfo {
        function typeOf(tn: TypeNode, n: Node, stripParams = false) {
            let t = typechecker.getTypeAtLocation(n)
            if (!t) return "None"
            if (stripParams) {
                t = t.getCallSignatures()[0].getReturnType()
            }
            const readableName = typechecker.typeToString(t, undefined, TypeFormatFlags.UseFullyQualifiedType)

            // TypeScript 2.0.0+ will assign constant variables numeric literal types which breaks the
            // type checking we do in the blocks
            // This can be a number literal '7' or a union type of them '0 | 1 | 2'
            if (/^\d/.test(readableName)) {
                return "number";
            }

            if (readableName == "this") {
                return getFullName(typechecker, t.symbol);
            }

            return readableName;
        }

        let kind = getSymbolKind(stmt)
        if (kind != SymbolKind.None) {
            let decl: FunctionLikeDeclaration = stmt as any;
            let attributes = parseComments(decl)

            if (attributes.weight < 0)
                return null;

            let m = /^(.*)\.(.*)/.exec(qName)
            let hasParams = kind == SymbolKind.Function || kind == SymbolKind.Method

            let pkg: string = null

            let src = getSourceFileOfNode(stmt)
            if (src) {
                let m = /^pxt_modules\/([^\/]+)/.exec(src.fileName)
                if (m)
                    pkg = m[1]
            }

            let extendsTypes: string[] = undefined

            if (kind == SymbolKind.Class || kind == SymbolKind.Interface) {
                let cl = stmt as ClassLikeDeclaration
                extendsTypes = []
                if (cl.heritageClauses)
                    for (let h of cl.heritageClauses) {
                        if (h.types) {
                            for (let t of h.types) {
                                extendsTypes.push(typeOf(t, t))
                            }
                        }
                    }
            }

            if (kind == SymbolKind.Enum || kind === SymbolKind.EnumMember) {
                (extendsTypes || (extendsTypes = [])).push("Number");
            }

            let r: SymbolInfo = {
                kind,
                qName,
                namespace: m ? m[1] : "",
                name: m ? m[2] : qName,
                fileName: stmt.getSourceFile().fileName,
                attributes,
                pkg,
                extendsTypes,
                retType:
                    stmt.kind == SyntaxKind.Constructor ? "void" :
                        kind == SymbolKind.Module ? "" :
                            typeOf(decl.type, decl, hasParams),
                parameters: !hasParams ? null : Util.toArray(decl.parameters).map((p, i) => {
                    let n = getName(p)
                    let desc = attributes.paramHelp[n] || ""
                    let minVal = attributes.paramMin && attributes.paramMin[n];
                    let maxVal = attributes.paramMax && attributes.paramMax[n];
                    let m = /\beg\.?:\s*(.+)/.exec(desc)
                    let props: PropertyDesc[];
                    let parameters: PropertyDesc[];
                    if (p.type && p.type.kind === SK.FunctionType) {
                        const callBackSignature = typechecker.getSignatureFromDeclaration(p.type as FunctionTypeNode);
                        const callbackParameters = callBackSignature.getParameters();
                        if (attributes.mutate === "objectdestructuring") {
                            assert(callbackParameters.length > 0);
                            props = typechecker.getTypeAtLocation(callbackParameters[0].valueDeclaration).getProperties().map(prop => {
                                return { name: prop.getName(), type: typechecker.typeToString(typechecker.getTypeOfSymbolAtLocation(prop, callbackParameters[0].valueDeclaration)) }
                            });
                        }
                        else {
                            parameters = callbackParameters.map((sym, i) => {
                                return {
                                    name: sym.getName(),
                                    type: typechecker.typeToString(typechecker.getTypeOfSymbolAtLocation(sym, p), undefined, TypeFormatFlags.UseFullyQualifiedType)
                                };
                            });
                        }
                    }
                    let options: pxt.Map<PropertyOption> = {};
                    const paramType = typechecker.getTypeAtLocation(p);
                    let isEnum = paramType && !!(paramType.flags & (TypeFlags.Enum | TypeFlags.EnumLiteral));

                    if (attributes.block && attributes.paramShadowOptions) {
                        const argNames: string[] = []
                        attributes.block.replace(/%(\w+)/g, (f, n) => {
                            argNames.push(n)
                            return ""
                        });
                        if (attributes.paramShadowOptions[argNames[i]]) {
                            options['fieldEditorOptions'] = { value: attributes.paramShadowOptions[argNames[i]] }
                        }
                    }
                    if (minVal) options['min'] = { value: minVal };
                    if (maxVal) options['max'] = { value: maxVal };
                    return {
                        name: n,
                        description: desc,
                        type: typeOf(p.type, p),
                        pyTypeString: emitType(p.type),
                        initializer:
                            p.initializer ? p.initializer.getText() :
                                getExplicitDefault(attributes, n) ||
                                (p.questionToken ? "undefined" : undefined),
                        default: attributes.paramDefl[n],
                        properties: props,
                        handlerParameters: parameters,
                        options: options,
                        isEnum
                    }
                }),
                snippet: ts.isFunctionLike(stmt) ? null : undefined
            }

            switch (r.kind) {
                case SymbolKind.EnumMember:
                    r.pyName = snakify(r.name).toUpperCase()
                    break
                case SymbolKind.Variable:
                case SymbolKind.Method:
                case SymbolKind.Property:
                case SymbolKind.Function:
                    r.pyName = snakify(r.name)
                    break
                case SymbolKind.Enum:
                case SymbolKind.Class:
                case SymbolKind.Interface:
                case SymbolKind.Module:
                default:
                    r.pyName = r.name
                    break
            }

            if (stmt.kind === SK.GetAccessor ||
                ((stmt.kind === SK.PropertyDeclaration || stmt.kind === SK.PropertySignature) && isReadonly(stmt as Declaration))) {
                r.isReadOnly = true
            }

            return r
        }
        return null;
    }

    export interface GenDocsOptions {
        package?: boolean;
        locs?: boolean;
        docs?: boolean;
        pxtsnippet?: pxt.SnippetConfig[]; // extract localizable strings from pxtsnippets.json files
    }

    export function genDocs(pkg: string, apiInfo: ApisInfo, options: GenDocsOptions = {}): pxt.Map<string> {
        pxt.debug(`generating docs for ${pkg}`)
        pxt.debug(JSON.stringify(Object.keys(apiInfo.byQName), null, 2))

        const files: pxt.Map<string> = {};
        const infos = Util.values(apiInfo.byQName);
        const enumMembers = infos.filter(si => si.kind == SymbolKind.EnumMember)
            .sort(compareSymbols);

        const snippetStrings: pxt.Map<string> = {};
        const locStrings: pxt.Map<string> = {};
        const jsdocStrings: pxt.Map<string> = {};
        const writeLoc = (si: SymbolInfo) => {
            if (!options.locs || !si.qName) {
                return;
            }
            if (/^__/.test(si.name))
                return; // skip functions starting with __
            pxt.debug(`loc: ${si.qName}`)
            // must match blockly loader
            if (si.kind != SymbolKind.EnumMember) {
                const ns = ts.pxtc.blocksCategory(si);
                if (ns)
                    locStrings[`{id:category}${ns}`] = ns;
            }
            if (si.attributes.jsDoc)
                jsdocStrings[si.qName] = si.attributes.jsDoc;
            if (si.attributes.block)
                locStrings[`${si.qName}|block`] = si.attributes.block;
            if (si.attributes.group)
                locStrings[`{id:group}${si.attributes.group}`] = si.attributes.group;
            if (si.attributes.subcategory)
                locStrings[`{id:subcategory}${si.attributes.subcategory}`] = si.attributes.subcategory;
            if (si.parameters)
                si.parameters.filter(pi => !!pi.description).forEach(pi => {
                    jsdocStrings[`${si.qName}|param|${pi.name}`] = pi.description;
                })
        }
        const mapLocs = (m: pxt.Map<string>, name: string) => {
            if (!options.locs) return;
            const locs: pxt.Map<string> = {};
            Object.keys(m).sort().forEach(l => locs[l] = m[l]);
            files[pkg + name + "-strings.json"] = JSON.stringify(locs, null, 2);
        }
        for (const info of infos) {
            const isNamespace = info.kind == SymbolKind.Module;
            if (isNamespace) {
                if (!infos.filter(si => si.namespace == info.name && !!si.attributes.jsDoc)[0])
                    continue; // nothing in namespace
                if (!info.attributes.block) info.attributes.block = info.name; // reusing this field to store localized namespace name
            }
            writeLoc(info);
        }
        if (options.locs)
            enumMembers.forEach(em => {
                if (em.attributes.block) locStrings[`${em.qName}|block`] = em.attributes.block;
                if (em.attributes.jsDoc) locStrings[em.qName] = em.attributes.jsDoc;
            });
        mapLocs(locStrings, "");
        mapLocs(jsdocStrings, "-jsdoc");
        // Localize pxtsnippets.json files
        if (options.pxtsnippet) {
            options.pxtsnippet.forEach(snippet => localizeSnippet(snippet, snippetStrings));
            mapLocs(snippetStrings, "-snippet");
        }

        return files;
    }

    function localizeSnippet(snippet: pxt.SnippetConfig, locs: pxt.Map<string>) {
        const localizableQuestionProperties = ['label', 'title', 'hint', 'errorMessage']; // TODO(jb) provide this elsewhere
        locs[snippet.label] = snippet.label;
        snippet.questions.forEach((question: pxt.Map<any>) => {
            localizableQuestionProperties.forEach((prop) => {
                if (question[prop]) {
                    locs[question[prop]] = question[prop];
                }
            });
        })
    }

    export function hasBlock(sym: SymbolInfo): boolean {
        return !!sym.attributes.block && !!sym.attributes.blockId;
    }

    let symbolKindWeight: pxt.Map<number>;
    export function compareSymbols(l: SymbolInfo, r: SymbolInfo): number {
        function cmpr(toValue: (s: SymbolInfo) => number) {
            const c = -toValue(l) + toValue(r)
            return c
        }

        // favor symbols with blocks
        let c = cmpr(s => hasBlock(s) ? 1 : -1);
        if (c) return c;

        // favor top-level symbols
        c = cmpr(s => !s.namespace ? 1 : -1)
        if (c) return c;

        // sort by symbol kind
        if (!symbolKindWeight) {
            symbolKindWeight = {};
            symbolKindWeight[SymbolKind.Variable] = 100;
            symbolKindWeight[SymbolKind.Module] = 101;
            symbolKindWeight[SymbolKind.Function] = 99;
            symbolKindWeight[SymbolKind.Property] = 98;
            symbolKindWeight[SymbolKind.Method] = 97;
            symbolKindWeight[SymbolKind.Class] = 89;
            symbolKindWeight[SymbolKind.Enum] = 81;
            symbolKindWeight[SymbolKind.EnumMember] = 80;
        }
        c = cmpr(s => symbolKindWeight[s.kind] || 0)
        if (c) return c;

        // check for a weight attribute
        c = cmpr(s => s.attributes.weight || 50)
        if (c) return c;

        return U.strcmp(l.name, r.name);
    }


    export function getApiInfo(program: Program, jres?: pxt.Map<pxt.JRes>, legacyOnly = false): ApisInfo {
        return internalGetApiInfo(program, jres, legacyOnly).apis;
    }

    export function internalGetApiInfo(program: Program, jres?: pxt.Map<pxt.JRes>, legacyOnly = false) {
        const res: ApisInfo = {
            byQName: {},
            jres: jres
        }
        const qNameToNode: pxt.Map<Declaration> = {};
        const typechecker = program.getTypeChecker()
        const collectDecls = (stmt: Node) => {
            if (stmt.kind == SK.VariableStatement) {
                let vs = stmt as VariableStatement
                vs.declarationList.declarations.forEach(collectDecls)
                return
            }

            if (isExported(stmt as Declaration)) {
                if (!stmt.symbol) {
                    console.warn("no symbol", stmt)
                    return;
                }
                let qName = getFullName(typechecker, stmt.symbol)
                if (stmt.kind == SK.SetAccessor)
                    qName += "@set" // otherwise we get a clash with the getter
                qNameToNode[qName] = stmt as Declaration;
                let si = createSymbolInfo(typechecker, qName, stmt)
                if (si) {
                    let existing = U.lookup(res.byQName, qName)
                    if (existing) {
                        // we can have a function and an interface of the same name
                        if (existing.kind == SymbolKind.Interface && si.kind != SymbolKind.Interface) {
                            // save existing entry
                            res.byQName[qName + "@type"] = existing
                        } else if (existing.kind != SymbolKind.Interface && si.kind == SymbolKind.Interface) {
                            res.byQName[qName + "@type"] = si
                            si = existing
                        } else {
                            si.attributes = parseCommentString(
                                existing.attributes._source + "\n" +
                                si.attributes._source)
                            if (existing.extendsTypes) {
                                si.extendsTypes = si.extendsTypes || []
                                existing.extendsTypes.forEach(t => {
                                    if (si.extendsTypes.indexOf(t) === -1) {
                                        si.extendsTypes.push(t);
                                    }
                                })
                            }
                        }
                    }
                    if (stmt.parent &&
                        (stmt.parent.kind == SK.ClassDeclaration || stmt.parent.kind == SK.InterfaceDeclaration) &&
                        !isStatic(stmt as Declaration))
                        si.isInstance = true
                    res.byQName[qName] = si
                }
            }

            if (stmt.kind == SK.ModuleDeclaration) {
                let mod = <ModuleDeclaration>stmt
                if (mod.body.kind == SK.ModuleBlock) {
                    let blk = <ModuleBlock>mod.body
                    blk.statements.forEach(collectDecls)
                } else if (mod.body.kind == SK.ModuleDeclaration) {
                    collectDecls(mod.body)
                }
            } else if (stmt.kind == SK.InterfaceDeclaration) {
                let iface = stmt as InterfaceDeclaration
                iface.members.forEach(collectDecls)
            } else if (stmt.kind == SK.ClassDeclaration) {
                let iface = stmt as ClassDeclaration
                iface.members.forEach(collectDecls)
            } else if (stmt.kind == SK.EnumDeclaration) {
                let e = stmt as EnumDeclaration
                e.members.forEach(collectDecls)
            }
        }

        for (let srcFile of program.getSourceFiles()) {
            srcFile.statements.forEach(collectDecls)
        }

        let toclose: SymbolInfo[] = []

        // store qName in symbols
        for (let qName in res.byQName) {
            let si = res.byQName[qName]
            si.qName = qName;
            si.attributes._source = null
            if (si.extendsTypes && si.extendsTypes.length) toclose.push(si)

            let jrname = si.attributes.jres
            if (jrname) {
                if (jrname == "true") jrname = qName
                let jr = U.lookup(jres || {}, jrname)
                if (jr && jr.icon && !si.attributes.iconURL) {
                    si.attributes.iconURL = jr.icon
                }
                if (jr && jr.data && !si.attributes.jresURL) {
                    si.attributes.jresURL = "data:" + jr.mimeType + ";base64," + jr.data
                }
            }

            if (si.pyName) {
                let override = U.lookup(ts2PyFunNameMap, si.qName);
                if (override && override.n) {
                    si.pyQName = override.n;
                    si.pySnippet = override.snippet;
                    si.pySnippetName = override.n;
                } else if (si.namespace) {
                    let par = res.byQName[si.namespace]
                    if (par) {
                        si.pyQName = par.pyQName + "." + si.pyName
                    } else {
                        // shouldn't happen
                        pxt.log("namespace missing: " + si.namespace)
                        si.pyQName = si.namespace + "." + si.pyName
                    }
                } else {
                    si.pyQName = si.pyName
                }
            }
        }

        // transitive closure of inheritance
        let closed: pxt.Map<boolean> = {}
        let closeSi = (si: SymbolInfo) => {
            if (U.lookup(closed, si.qName)) return;
            closed[si.qName] = true
            let mine: pxt.Map<boolean> = {}
            mine[si.qName] = true
            for (let e of si.extendsTypes || []) {
                mine[e] = true
                let psi = res.byQName[e]
                if (psi) {
                    closeSi(psi)
                    for (let ee of psi.extendsTypes) mine[ee] = true
                }
            }
            si.extendsTypes = Object.keys(mine)
        }
        toclose.forEach(closeSi)

        if (legacyOnly) {
            // conflicts with pins.map()
            delete res.byQName["Array.map"]
        }

        return {
            apis: res,
            decls: qNameToNode
        }
    }

    export function getFullName(typechecker: TypeChecker, symbol: Symbol): string {
        if ((symbol as any).isBogusSymbol)
            return symbol.name
        return typechecker.getFullyQualifiedName(symbol);
    }
}


namespace ts.pxtc.service {
    let emptyOptions: CompileOptions = {
        fileSystem: {},
        sourceFiles: [],
        target: { isNative: false, hasHex: false, switches: {} }
    }

    class Host implements LanguageServiceHost {
        opts = emptyOptions;
        fileVersions: pxt.Map<number> = {};
        projectVer = 0;
        pxtModulesOK: string = null;

        getProjectVersion() {
            return this.projectVer + ""
        }

        setFile(fn: string, cont: string) {
            if (this.opts.fileSystem[fn] != cont) {
                this.fileVersions[fn] = (this.fileVersions[fn] || 0) + 1
                this.opts.fileSystem[fn] = cont
                this.projectVer++
            }
        }

        reset() {
            this.setOpts(emptyOptions)
            this.pxtModulesOK = null
        }

        setOpts(o: CompileOptions) {
            Util.iterMap(o.fileSystem, (fn, v) => {
                if (this.opts.fileSystem[fn] != v) {
                    this.fileVersions[fn] = (this.fileVersions[fn] || 0) + 1
                }
            })
            this.opts = o
            this.projectVer++
        }

        getCompilationSettings(): CompilerOptions {
            return getTsCompilerOptions(this.opts)
        }

        getScriptFileNames(): string[] {
            return this.opts.sourceFiles.filter(f => U.endsWith(f, ".ts"));
        }

        getScriptVersion(fileName: string): string {
            return (this.fileVersions[fileName] || 0).toString()
        }

        getScriptSnapshot(fileName: string): IScriptSnapshot {
            let f = this.opts.fileSystem[fileName]
            if (f)
                return ScriptSnapshot.fromString(f)
            else
                return null
        }

        getNewLine() { return "\n" }
        getCurrentDirectory(): string { return "." }
        getDefaultLibFileName(options: CompilerOptions): string { return "no-default-lib.d.ts" }
        log(s: string): void { console.log("LOG", s) }
        trace(s: string): void { console.log("TRACE", s) }
        error(s: string): void { console.error("ERROR", s) }
        useCaseSensitiveFileNames(): boolean { return true }

        // resolveModuleNames?(moduleNames: string[], containingFile: string): ResolvedModule[];
        // directoryExists?(directoryName: string): boolean;
    }

    let service: LanguageService;
    let host: Host;

    interface CachedApisInfo {
        apis: ApisInfo;
        decls: pxt.Map<Declaration>;
    }

    let lastApiInfo: CachedApisInfo | undefined;
    let lastPyIdentifierSyntaxInfo: SyntaxInfo | undefined;
    let lastBlocksInfo: BlocksInfo;
    let lastLocBlocksInfo: BlocksInfo;
    let lastFuse: Fuse<SearchInfo>;
    let lastProjectFuse: Fuse<ProjectSearchInfo>;
    let builtinItems: SearchInfo[];
    let blockDefinitions: pxt.Map<pxt.blocks.BlockDefinition>;
    let tbSubset: pxt.Map<boolean | string>;

    function fileDiags(fn: string) {
        if (!/\.ts$/.test(fn))
            return []

        let d = service.getSyntacticDiagnostics(fn)
        if (!d || !d.length)
            d = service.getSemanticDiagnostics(fn)
        if (!d) d = []
        return d
    }

    interface InternalCompletionData {
        symbols: ts.Symbol[];
        isMemberCompletion: boolean;
        isNewIdentifierLocation: boolean;
        location: ts.Node;
        isRightOfDot: boolean;
        isJsDocTagName: boolean;
    }

    const blocksInfoOp = (apisInfoLocOverride: pxtc.ApisInfo, bannedCategories: string[]) => {
        if (apisInfoLocOverride) {
            if (!lastLocBlocksInfo) {
                lastLocBlocksInfo = getBlocksInfo(apisInfoLocOverride, bannedCategories);
            }
            return lastLocBlocksInfo;
        } else {
            if (!lastBlocksInfo) {
                lastBlocksInfo = getBlocksInfo(lastApiInfo.apis, bannedCategories);
            }
            return lastBlocksInfo;
        }
    }

    function addApiInfo(opts: CompileOptions) {
        if (!opts.apisInfo && opts.target.preferredEditor == pxt.PYTHON_PROJECT_NAME) {
            if (!lastApiInfo)
                lastApiInfo = internalGetApiInfo(service.getProgram(), opts.jres)
            opts.apisInfo = U.clone(lastApiInfo.apis)
        }
    }

    function cloneCompileOpts(opts: CompileOptions) {
        let newOpts = pxt.U.flatClone(opts)
        newOpts.fileSystem = pxt.U.flatClone(newOpts.fileSystem)
        return newOpts
    }

    const operations: pxt.Map<(v: OpArg) => any> = {
        reset: () => {
            service.cleanupSemanticCache();
            lastApiInfo = undefined
            lastPyIdentifierSyntaxInfo = undefined
            host.reset()
            transpile.resetCache()
        },

        setOptions: v => {
            host.setOpts(v.options)
        },

        syntaxInfo: v => {
            // TODO: Currently this is only used for Python's language service. Ideally we should
            // use this for Typescript too but that might require some emitter or other work.
            let src: string = v.fileContent
            if (v.fileContent) {
                host.setFile(v.fileName, v.fileContent);
            }
            let opts = cloneCompileOpts(host.opts)
            opts.fileSystem[v.fileName] = src
            opts.syntaxInfo = {
                position: v.position,
                type: v.infoType
            };
            if (opts.target.preferredEditor == pxt.PYTHON_PROJECT_NAME) {
                addApiInfo(opts);
                let res = transpile.pyToTs(opts)
                if (res.syntaxInfo && res.syntaxInfo.symbols) {
                    lastPyIdentifierSyntaxInfo = res.syntaxInfo
                }
                if (lastPyIdentifierSyntaxInfo)
                    return lastPyIdentifierSyntaxInfo
            }
            return opts.syntaxInfo
        },

        getCompletions: v => {
            console.log("GET COMPLETIONS $$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$")
            const { fileName, fileContent, position, wordStartPos, wordEndPos, runtime } = v
            let src: string = fileContent
            if (fileContent) {
                host.setFile(fileName, fileContent);
            }

            const span: PosSpan = { startPos: wordStartPos, endPos: wordEndPos }

            const isPython = /\.py$/.test(fileName);
            let dotIdx = -1
            let complPosition = -1
            for (let i = position - 1; i >= 0; --i) {
                if (src[i] == ".") {
                    dotIdx = i
                    break
                }
                if (!/\w/.test(src[i]))
                    break
                if (complPosition == -1)
                    complPosition = i
            }

            if (dotIdx == position - 1) {
                // "foo.|" -> we add "_" as field name to minimize the risk of a parse error
                src = src.slice(0, position) + "_" + src.slice(position)
            } else if (complPosition == -1) {
                src = src.slice(0, position) + "_" + src.slice(position)
                complPosition = position
            }

            let lastNl = src.lastIndexOf("\n", position)
            lastNl = Math.max(0, lastNl)
            const cursorLine = src.substring(lastNl, position)
            console.log(cursorLine)

            if (dotIdx != -1)
                complPosition = dotIdx

            const entries: pxt.Map<SymbolInfo> = {};
            const r: CompletionInfo = {
                entries: [],
                isMemberCompletion: dotIdx != -1,
                isNewIdentifierLocation: true,
                isTypeLocation: false
            }

            let opts = cloneCompileOpts(host.opts)
            opts.fileSystem[fileName] = src
            addApiInfo(opts);
            opts.syntaxInfo = {
                position: complPosition,
                type: r.isMemberCompletion ? "memberCompletion" : "identifierCompletion"
            };

            let resultSymbols: SymbolInfo[] = []

            let tsPos: number;
            if (isPython) {
                const res = transpile.pyToTs(opts)
                if (res.syntaxInfo && res.syntaxInfo.symbols) {
                    lastPyIdentifierSyntaxInfo = res.syntaxInfo
                    resultSymbols = opts.syntaxInfo.symbols
                }

                // update our language host
                Object.keys(res.outfiles)
                    .forEach(k => {
                        if (k.endsWith(".ts")) {
                            host.setFile(k, res.outfiles[k])
                        }
                    })

                // convert our location from python to typescript
                if (res.sourceMap) {
                    const pySrc = src
                    const tsSrc = res.outfiles["main.ts"]
                    const srcMap = pxtc.BuildSourceMapHelpers(res.sourceMap, tsSrc, pySrc)

                    const smallest = srcMap.py.smallestOverlap(span)
                    if (smallest) {
                        tsPos = smallest.ts.startPos
                    }
                }
            } else {
                tsPos = position
                // TODO: get better default result symbols for typescript
                resultSymbols = pxt.U.values(lastApiInfo.apis.byQName)
            }


            function findInnerMostNodeAtPosition(n: Node): Node {
                for (let child of n.getChildren()) {
                    let s = child.getStart()
                    let e = child.getEnd()
                    if (s <= tsPos && tsPos < e)
                        return findInnerMostNodeAtPosition(child)
                }
                return n
            }

            function findCallExpression(n: Node): ts.CallExpression | undefined {
                if (ts.isCallExpression(n))
                    return n
                else if (n.parent) {
                    return findCallExpression(n.parent)
                }
                return undefined
            }

            const prog = service.getProgram()
            const tsAst = prog.getSourceFile("main.ts") // TODO: work for non-main files
            const innerMost = findInnerMostNodeAtPosition(tsAst)
            if (innerMost) {
                console.log("INNER MOST")
                console.dir({ tsPos, tsAst, innerMost })
                const tc = prog.getTypeChecker()
                const call = findCallExpression(innerMost)

                if (call) {
                    console.log("CALL")
                    console.dir(call)
                    function findArgIdx() {
                        // does our cursor syntax node trivially map to an argument?
                        let paramIdx = call.arguments
                            .map(a => a === innerMost)
                            .indexOf(true)
                        if (paramIdx >= 0)
                            return paramIdx

                        // is our cursor within the argument range?
                        const inRange = call.arguments.pos <= tsPos && tsPos < call.end
                        if (!inRange)
                            return -1

                        // is our cursor pointing at one of the pieces of syntax of the call? E.g. "," or ")" or " "
                        const isTopLeveLSyntax = [call, ...call.getChildren()]
                            .map(a => a === innerMost)
                            .reduce((p, n) => p || n, false)
                        if (!isTopLeveLSyntax)
                            return -1

                        // no arguments?
                        if (call.arguments.length === 0)
                            return 0

                        // then find which argument we're refering to
                        paramIdx = 0;
                        for (let a of call.arguments) {
                            if (a.end <= tsPos)
                                paramIdx++
                            else
                                break
                        }
                        if (!call.arguments.hasTrailingComma)
                            paramIdx = Math.max(0, paramIdx - 1)

                        return paramIdx
                    }

                    // which argument are we ?
                    let paramIdx = findArgIdx()

                    // if we're not one of the arguments, are we at the 
                    // determine parameter idx

                    if (paramIdx >= 0) {
                        const blocksInfo = blocksInfoOp(lastApiInfo.apis, runtime.bannedCategories);
                        const callSym = getCallSymbol(call)
                        if (callSym) {
                            if (paramIdx >= callSym.parameters.length)
                                paramIdx = callSym.parameters.length - 1
                            const paramType = getParameterTsType(callSym, paramIdx, blocksInfo)
                            console.dir({ paramType })
                            if (paramType) {
                                const matchingApis = getApisForTsType(paramType, call, tc)
                                console.dir({ matchingApis })
                                resultSymbols = matchingApis
                            }
                        }
                    }
                }
            }

            // determine which names are taken for auto-generated variable names
            let takenNames: pxt.Map<SymbolInfo> = {}
            if (isPython && lastPyIdentifierSyntaxInfo && lastPyIdentifierSyntaxInfo.globalNames) {
                takenNames = lastPyIdentifierSyntaxInfo.globalNames
            } else {
                takenNames = lastApiInfo.apis.byQName
            }

            function shouldUseSymbol(si: SymbolInfo) {
                let use = !(
                    /^__/.test(si.name) || // ignore members starting with __
                    /^__/.test(si.namespace) || // ignore namespaces starting with __
                    si.attributes.hidden ||
                    si.attributes.deprecated ||
                    // ignore TD_ID helpers
                    si.attributes.shim == "TD_ID"
                )
                return use
            }

            function patchSymbolWithSnippet(si: SymbolInfo) {
                const n = lastApiInfo.decls[si.qName];
                if (isFunctionLike(n)) {
                    // snippet/pySnippet might have been set already
                    if ((isPython && !si.pySnippet)
                        || (!isPython && !si.snippet)) {
                        let snippet = getSnippet(lastApiInfo.apis, takenNames, v.runtime, si, n, isPython);
                        if (isPython)
                            si.pySnippet = snippet
                        else
                            si.snippet = snippet
                    }
                }
            }

            // swap aliases, filter symbols and add snippets
            resultSymbols
                .map(si => si.attributes.alias ? lastApiInfo.apis.byQName[si.attributes.alias] : si)
                .filter(shouldUseSymbol)
                .forEach(si => {
                    entries[si.qName] = si
                    patchSymbolWithSnippet(si)
                })

            // sort entries
            r.entries = pxt.Util.values(entries)
                .filter(a => !!a);
            r.entries.sort(compareSymbols);

            // TODO:
            console.log("MC completion")

            return r;
        },

        compile: v => {
            host.setOpts(v.options)
            const res = runConversionsAndCompileUsingService()
            timesToMs(res);
            return res
        },
        decompile: v => {
            host.setOpts(v.options)
            return decompile(service.getProgram(), v.options, v.fileName, false);
        },
        pydecompile: v => {
            host.setOpts(v.options)
            return transpile.tsToPy(service.getProgram(), v.fileName);

        },
        assemble: v => {
            return {
                words: processorInlineAssemble(host.opts.target, v.fileContent)
            }
        },

        py2ts: v => {
            addApiInfo(v.options)
            return transpile.pyToTs(v.options)
        },

        fileDiags: v => patchUpDiagnostics(fileDiags(v.fileName)),

        allDiags: () => {
            // not comapatible with incremental compilation
            // host.opts.noEmit = true
            // TODO: "allDiags" sounds like it's just reading state
            // but it's actually kicking off a full compile. We should
            // do better about caching and returning cached results from
            // previous compiles.
            let res = runConversionsAndCompileUsingService();
            timesToMs(res);
            if (host.opts.target.switches.time)
                console.log("DIAG-TIME", res.times)
            return res
        },

        format: v => {
            const formatOptions = v.format;
            return pxtc.format(formatOptions.input, formatOptions.pos);
        },

        apiInfo: () => {
            lastBlocksInfo = undefined;
            lastFuse = undefined;
            if (host.opts === emptyOptions) {
                // Host was reset, don't load apis with empty options
                return undefined;
            }
            lastApiInfo = internalGetApiInfo(service.getProgram(), host.opts.jres);
            return lastApiInfo.apis;
        },
        snippet: v => {
            const o = v.snippet;
            if (!lastApiInfo) return undefined;
            const fn = lastApiInfo.apis.byQName[o.qName];
            const n = lastApiInfo.decls[o.qName];
            if (!fn || !n || !ts.isFunctionLike(n))
                return undefined;
            return ts.pxtc.service.getSnippet(lastApiInfo.apis, lastApiInfo.apis.byQName, v.runtime, fn, n as FunctionLikeDeclaration, !!o.python)
        },
        blocksInfo: v => blocksInfoOp(v as any, v.blocks && v.blocks.bannedCategories),
        apiSearch: v => {
            const SEARCH_RESULT_COUNT = 7;
            const search = v.search;
            const blockInfo = blocksInfoOp(search.localizedApis, v.blocks && v.blocks.bannedCategories); // caches

            if (search.localizedStrings) {
                pxt.Util.setLocalizedStrings(search.localizedStrings);
            }

            // Computes the preferred tooltip or block text to use for search (used for blocks that have multiple tooltips or block texts)
            const computeSearchProperty = (tooltipOrBlock: string | pxt.Map<string>, preferredSearch: string, blockDef: pxt.blocks.BlockDefinition): string => {
                if (!tooltipOrBlock) {
                    return undefined;
                }
                if (typeof tooltipOrBlock === "string") {
                    // There is only one tooltip or block text; use it
                    return tooltipOrBlock;
                }
                if (preferredSearch) {
                    // The block definition specifies a preferred tooltip / block text to use for search; use it
                    return (<any>tooltipOrBlock)[preferredSearch];
                }
                // The block definition does not specify which tooltip or block text to use for search; join all values with a space
                return Object.keys(tooltipOrBlock).map(k => (<pxt.Map<string>>tooltipOrBlock)[k]).join(" ");
            };

            if (!builtinItems) {
                builtinItems = [];
                blockDefinitions = pxt.blocks.blockDefinitions();
                for (const id in blockDefinitions) {
                    const blockDef = blockDefinitions[id];

                    if (blockDef.operators) {
                        for (const op in blockDef.operators) {
                            const opValues = blockDef.operators[op];
                            opValues.forEach(v => builtinItems.push({
                                id,
                                name: blockDef.name,
                                jsdoc: typeof blockDef.tooltip === "string" ? <string>blockDef.tooltip : (<pxt.Map<string>>blockDef.tooltip)[v],
                                block: v,
                                field: [op, v],
                                builtinBlock: true
                            }));
                        }
                    }
                    else {
                        builtinItems.push({
                            id,
                            name: blockDef.name,
                            jsdoc: computeSearchProperty(blockDef.tooltip, blockDef.tooltipSearch, blockDef),
                            block: computeSearchProperty(blockDef.block, blockDef.blockTextSearch, blockDef),
                            builtinBlock: true
                        });
                    }
                }
            }

            let subset: SymbolInfo[];

            const fnweight = (fn: ts.pxtc.SymbolInfo): number => {
                const fnw = fn.attributes.weight || 50;
                const nsInfo = blockInfo.apis.byQName[fn.namespace];
                const nsw = nsInfo ? (nsInfo.attributes.weight || 50) : 50;
                const ad = (nsInfo ? nsInfo.attributes.advanced : false) || fn.attributes.advanced
                const weight = (nsw * 1000 + fnw) * (ad ? 1 : 1e6);
                return weight;
            }

            if (!lastFuse || search.subset) {
                const weights: pxt.Map<number> = {};
                let builtinSearchSet: SearchInfo[] = [];

                if (search.subset) {
                    tbSubset = search.subset;
                    builtinSearchSet = builtinItems.filter(s => !!tbSubset[s.id]);
                }

                if (tbSubset) {
                    subset = blockInfo.blocks.filter(s => !!tbSubset[s.attributes.blockId]);
                }
                else {
                    subset = blockInfo.blocks;
                    builtinSearchSet = builtinItems;
                }

                let searchSet: SearchInfo[] = subset.map(s => {
                    const mappedSi: SearchInfo = {
                        id: s.attributes.blockId,
                        qName: s.qName,
                        name: s.name,
                        namespace: s.namespace,
                        block: s.attributes.block,
                        jsdoc: s.attributes.jsDoc,
                        localizedCategory: tbSubset && typeof tbSubset[s.attributes.blockId] === "string"
                            ? tbSubset[s.attributes.blockId] as string : undefined
                    };
                    return mappedSi;
                });

                // filter out built-ins from the main search set as those
                // should come from the built-in search set
                let builtinBlockIds: pxt.Map<Boolean> = {}
                builtinSearchSet.forEach(b => builtinBlockIds[b.id] = true)
                searchSet = searchSet.filter(b => !(b.id in builtinBlockIds));

                let mw = 0;
                subset.forEach(b => {
                    const w = weights[b.qName] = fnweight(b);
                    mw = Math.max(mw, w);
                });

                searchSet = searchSet.concat(builtinSearchSet);

                const fuseOptions = {
                    shouldSort: true,
                    threshold: 0.6,
                    location: 0,
                    distance: 100,
                    maxPatternLength: 16,
                    minMatchCharLength: 2,
                    findAllMatches: false,
                    caseSensitive: false,
                    keys: [
                        { name: 'name', weight: 0.3 },
                        { name: 'namespace', weight: 0.1 },
                        { name: 'localizedCategory', weight: 0.1 },
                        { name: 'block', weight: 0.4375 },
                        { name: 'jsdoc', weight: 0.0625 }
                    ],
                    sortFn: function (a: any, b: any): number {
                        const wa = a.qName ? 1 - weights[a.item.qName] / mw : 1;
                        const wb = b.qName ? 1 - weights[b.item.qName] / mw : 1;
                        // allow 10% wiggle room for weights
                        return a.score * (1 + wa / 10) - b.score * (1 + wb / 10);
                    }
                };
                lastFuse = new Fuse(searchSet, fuseOptions);
            }
            const fns = lastFuse.search(search.term);
            return fns.slice(0, SEARCH_RESULT_COUNT);
        },
        projectSearch: v => {
            const search = v.projectSearch;
            const searchSet = search.headers;

            if (!lastProjectFuse) {
                const fuseOptions = {
                    shouldSort: true,
                    threshold: 0.6,
                    location: 0,
                    distance: 100,
                    maxPatternLength: 16,
                    minMatchCharLength: 2,
                    findAllMatches: false,
                    caseSensitive: false,
                    keys: [
                        { name: 'name', weight: 0.3 }
                    ]
                };
                lastProjectFuse = new Fuse(searchSet, fuseOptions);
            }
            const fns = lastProjectFuse.search(search.term);
            return fns;
        },
        projectSearchClear: () => {
            lastProjectFuse = undefined;
        }
    }

    function getCallSymbol(callExp: CallExpression): SymbolInfo {// pxt symbol
        const callTs = callExp.expression.getText()
        const api = lastApiInfo.apis.byQName[callTs]
        return api
    }

    function getParameterTsType(callSym: SymbolInfo, paramIdx: number, blocksInfo: BlocksInfo): string | undefined {
        if (!callSym || paramIdx < 0)
            return undefined;

        const paramDesc = callSym.parameters[paramIdx]
        console.dir({ paramDesc })
        let result = paramDesc.type;

        // check if this parameter has a shadow block, if so use the type from that instead
        if (callSym.attributes._def) {
            const blockParams = callSym.attributes._def.parameters
            const blockParam = blockParams[paramIdx]

            const shadowId = blockParam.shadowBlockId
            if (shadowId) {
                const shadowBlk = blocksInfo.blocksById[shadowId]
                const shadowApi = lastApiInfo.apis.byQName[shadowBlk.qName]

                const isPassThrough = shadowApi.attributes.shim === "TD_ID"
                if (isPassThrough && shadowApi.parameters.length === 1) {
                    const realTyp = shadowApi.parameters[0].type
                    result = realTyp
                }
            }
        }

        return result
    }

    function getApisForTsType(pxtType: string, location: Node, tc: TypeChecker): SymbolInfo[] {
        // any apis that return this type?
        // TODO: if this becomes expensive, this can be cached between calls since the same
        // return type is likely to occur over and over.
        const apisByRetType: pxt.Map<SymbolInfo[]> = {}
        pxt.U.values(lastApiInfo.apis.byQName)
            .forEach(i => {
                apisByRetType[i.retType] = [...(apisByRetType[i.retType] || []), i]
            })

        const retApis = apisByRetType[pxtType]

        // any enum members?
        let enumVals: SymbolInfo[] = []
        for (let r of retApis) {
            const asTsEnum = getTsSymbolFromPxtSymbol(r, location, SymbolFlags.Enum)
            if (asTsEnum) {
                const enumType = tc.getTypeOfSymbolAtLocation(asTsEnum, location)
                const mems = getEnumMembers(enumType)
                const enumValQNames = mems.map(e => enumMemberToQName(tc, e))
                const symbols = enumValQNames.map(n => lastApiInfo.apis.byQName[n])
                enumVals = [...enumVals, ...symbols]
            }
        }

        return [...retApis, ...enumVals]
    }

    function runConversionsAndCompileUsingService(): CompileResult {
        addApiInfo(host.opts)
        const prevFS = U.flatClone(host.opts.fileSystem);
        let res = runConversionsAndStoreResults(host.opts);
        const newFS = host.opts.fileSystem
        host.opts.fileSystem = prevFS
        for (let k of Object.keys(newFS))
            host.setFile(k, newFS[k]) // update version numbers
        if (res.diagnostics.length == 0) {
            host.opts.skipPxtModulesEmit = false
            host.opts.skipPxtModulesTSC = false
            const currKey = host.opts.target.isNative ? "native" : "js"
            if (!host.opts.target.switches.noIncr && host.pxtModulesOK) {
                host.opts.skipPxtModulesTSC = true
                if (host.opts.noEmit)
                    host.opts.skipPxtModulesEmit = true
                else if (host.opts.target.isNative)
                    host.opts.skipPxtModulesEmit = false
                // don't cache emit when debugging pxt_modules/*
                else if (host.pxtModulesOK == "js" && (!host.opts.breakpoints || host.opts.justMyCode))
                    host.opts.skipPxtModulesEmit = true
            }
            let ts2asm = compile(host.opts, service)
            res = { sourceMap: res.sourceMap, ...ts2asm }
            if (res.needsFullRecompile) {
                pxt.log("trigering full recompile")
                pxt.tickEvent("compile.fullrecompile")
                host.opts.skipPxtModulesEmit = false
                ts2asm = compile(host.opts, service);
                res = { sourceMap: res.sourceMap, ...ts2asm }
            }
            if (res.diagnostics.every(d => !isPxtModulesFilename(d.fileName)))
                host.pxtModulesOK = currKey
        }
        return res;
    }

    export function performOperation(op: string, arg: OpArg) {
        init();
        let res: any = null;

        if (operations.hasOwnProperty(op)) {
            try {
                res = operations[op](arg) || {}
            } catch (e) {
                res = {
                    errorMessage: e.stack
                }
            }
        } else {
            res = {
                errorMessage: "No such operation: " + op
            }
        }

        return res
    }

    function init() {
        if (!service) {
            host = new Host()
            service = ts.createLanguageService(host)
        }
    }
    const defaultImgLit = `\`
. . . . .
. . . . .
. . # . .
. . . . .
. . . . .
\``;

    export function getSnippet(apis: ApisInfo, takenNames: pxt.Map<SymbolInfo>, runtimeOps: pxt.RuntimeOptions, fn: SymbolInfo, decl: ts.FunctionLikeDeclaration, python?: boolean): string {
        const PY_INDENT: string = (pxt as any).py.INDENT;

        let findex = 0;
        let preStmt = "";

        let fnName = ""
        if (decl.kind == SK.Constructor) {
            fnName = getSymbolName(decl.symbol) || decl.parent.name.getText();
        } else {
            fnName = getSymbolName(decl.symbol) || decl.name.getText();
        }

        if (python)
            fnName = snakify(fnName);

        function getUniqueName(inName: string): string {
            if (takenNames[inName])
                return ts.pxtc.decompiler.getNewName(inName, takenNames, false)
            return inName
        }

        const attrs = fn.attributes;

        const checker = service && service.getProgram().getTypeChecker();

        const blocksInfo = blocksInfoOp(apis, runtimeOps.bannedCategories);
        const blocksById = blocksInfo.blocksById

        function getShadowSymbol(paramName: string): SymbolInfo | null {
            // TODO(dz): unify this with auto-complete smarts?
            let shadowBlock = (attrs._shadowOverrides || {})[paramName]
            if (!shadowBlock)
                return null
            let sym = blocksById[shadowBlock]
            if (!sym)
                return null
            if (sym.attributes.shim === "TD_ID" && sym.parameters.length) {
                let realName = sym.parameters[0].type
                let realSym = apis.byQName[realName]
                sym = realSym || sym
            }
            return sym
        }

        function getParameterDefault(param: ParameterDeclaration) {
            const typeNode = param.type;
            if (!typeNode) return python ? "None" : "null";

            const name = param.name.kind === SK.Identifier ? (param.name as ts.Identifier).text : undefined;

            // check for explicit default in the attributes
            if (attrs && attrs.paramDefl && attrs.paramDefl[name]) {
                if (typeNode.kind == SK.StringKeyword) {
                    const defaultName = attrs.paramDefl[name];
                    return typeNode.kind == SK.StringKeyword && defaultName.indexOf(`"`) != 0 ? `"${defaultName}"` : defaultName;
                }
                return attrs.paramDefl[name];
            }

            function getDefaultValueOfType(type: ts.Type): string | null {
                // TODO: generalize this to handle more types
                if (type.symbol && type.symbol.flags & SymbolFlags.Enum) {
                    return getDefaultEnumValue(type, python);
                }
                if (isObjectType(type)) {
                    const typeSymbol = apis.byQName[checker.getFullyQualifiedName(type.symbol)];
                    const snip = typeSymbol && typeSymbol.attributes && (python ? typeSymbol.attributes.pySnippet : typeSymbol.attributes.snippet);
                    if (snip) return snip;
                    if (type.objectFlags & ts.ObjectFlags.Anonymous) {
                        const sigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
                        if (sigs && sigs.length) {
                            return getFunctionString(sigs[0]);
                        }
                        return emitFn(name);
                    }
                }
                if (type.flags & ts.TypeFlags.NumberLike) {
                    return "0";
                }
                return null
            }

            function getShadowSymbol(paramName: string): SymbolInfo | null {
                // TODO: generalize and unify this with getCompletions code
                let shadowBlock = (attrs._shadowOverrides || {})[paramName]
                if (!shadowBlock)
                    return null
                let sym = blocksById[shadowBlock]
                if (!sym)
                    return null
                if (sym.attributes.shim === "TD_ID" && sym.parameters.length) {
                    let realName = sym.parameters[0].type
                    let realSym = apis.byQName[realName]
                    sym = realSym || sym
                }
                return sym
            }

            // check if there's a shadow override defined
            let shadowSymbol = getShadowSymbol(name)
            if (shadowSymbol) {
                let tsSymbol = getTsSymbolFromPxtSymbol(shadowSymbol, param, SymbolFlags.Enum)
                if (tsSymbol) {
                    let shadowType = checker.getTypeOfSymbolAtLocation(tsSymbol, param)
                    if (shadowType) {
                        let shadowDef = getDefaultValueOfType(shadowType)
                        if (shadowDef) {
                            return shadowDef
                        }
                    }
                }
            }

            // simple types we can determine defaults for
            // TODO: move into getDefaultValueOfType
            switch (typeNode.kind) {
                case SK.StringKeyword: return (name == "leds" ? defaultImgLit : `""`);
                case SK.NumberKeyword: return "0";
                case SK.BooleanKeyword: return python ? "False" : "false";
                case SK.ArrayType: return "[]";
                case SK.TypeReference:
                    // handled below
                    break;
                case SK.FunctionType:
                    const tn = typeNode as ts.FunctionTypeNode;
                    let functionSignature = checker ? checker.getSignatureFromDeclaration(tn) : undefined;
                    if (functionSignature) {
                        return getFunctionString(functionSignature);
                    }
                    return emitFn(name);
            }

            // get default of type
            let type = checker && checker.getTypeAtLocation(param);
            if (type) {
                let typeDef = getDefaultValueOfType(type)
                if (typeDef)
                    return typeDef
            }

            // lastly, null or none
            return python ? "None" : "null";
        }

        const args = decl.parameters ? decl.parameters
            .filter(param => !param.initializer && !param.questionToken)
            .map(getParameterDefault) : [];

        let snippetPrefix = (fn.attributes.blockNamespace || fn.namespace);
        let isInstance = false;
        let addNamespace = false;
        let namespaceToUse = "";
        let functionCount = 0;

        const element = fn as pxtc.SymbolInfo;
        if (element.attributes.block) {
            if (element.attributes.defaultInstance) {
                snippetPrefix = element.attributes.defaultInstance;
                if (python && snippetPrefix)
                    snippetPrefix = snakify(snippetPrefix);
            }
            else if (element.namespace) { // some blocks don't have a namespace such as parseInt
                const nsInfo = apis.byQName[element.namespace];
                if (nsInfo.attributes.fixedInstances) {
                    let instances = Util.values(apis.byQName)
                    let getExtendsTypesFor = function (name: string) {
                        return instances
                            .filter(v => v.extendsTypes)
                            .filter(v => v.extendsTypes.reduce((x, y) => x || y.indexOf(name) != -1, false))
                            .reduce((x, y) => x.concat(y.extendsTypes), [])
                    }
                    // if blockNamespace exists, e.g., "pins", use it for snippet
                    // else use nsInfo.namespace, e.g., "motors"
                    namespaceToUse = element.attributes.blockNamespace || nsInfo.namespace || "";
                    // all fixed instances for this namespace
                    let fixedInstances = instances.filter(value =>
                        value.kind === pxtc.SymbolKind.Variable &&
                        value.attributes.fixedInstance
                    );
                    // first try to get fixed instances whose retType matches nsInfo.name
                    // e.g., DigitalPin
                    let exactInstances = fixedInstances.filter(value =>
                        value.retType == nsInfo.qName)
                        .sort((v1, v2) => v1.name.localeCompare(v2.name));
                    if (exactInstances.length) {
                        snippetPrefix = `${getName(exactInstances[0])}`
                    } else {
                        // second choice: use fixed instances whose retType extends type of nsInfo.name
                        // e.g., nsInfo.name == AnalogPin and instance retType == PwmPin
                        let extendedInstances = fixedInstances.filter(value =>
                            getExtendsTypesFor(nsInfo.qName).indexOf(value.retType) !== -1)
                            .sort((v1, v2) => v1.name.localeCompare(v2.name));
                        if (extendedInstances.length) {
                            snippetPrefix = `${getName(extendedInstances[0])}`
                        }
                    }
                    isInstance = true;
                    addNamespace = true;
                }
                else if (element.kind == pxtc.SymbolKind.Method || element.kind == pxtc.SymbolKind.Property) {
                    const params = pxt.blocks.compileInfo(element);
                    if (params.thisParameter) {
                        snippetPrefix = params.thisParameter.defaultValue || params.thisParameter.definitionName;
                        if (python && snippetPrefix)
                            snippetPrefix = snakify(snippetPrefix);
                    }
                    isInstance = true;
                }
                else if (nsInfo.kind === pxtc.SymbolKind.Class) {
                    return undefined;
                }
            }
        }

        let snippet = `${fnName}(${args.join(', ')})`;
        let insertText = snippetPrefix ? `${snippetPrefix}.${snippet}` : snippet;
        insertText = addNamespace ? `${firstWord(namespaceToUse)}.${insertText}` : insertText;

        if (attrs && attrs.blockSetVariable) {
            if (python) {
                let varName = snakify(attrs.blockSetVariable);
                varName = getUniqueName(varName)
                insertText = `${varName} = ${insertText}`;
            } else {
                insertText = `let ${attrs.blockSetVariable} = ${insertText}`;
            }
        }

        return preStmt + insertText;

        function getSymbolName(symbol: Symbol) {
            if (checker) {
                const qName = getFullName(checker, symbol);
                const si = apis.byQName[qName];
                if (si)
                    return getName(si);
            }
            return undefined;
        }

        function getName(si: SymbolInfo) {
            return python ? si.pyName : si.name;
        }

        function firstWord(s: string): string {
            const i = s.indexOf('.');
            return i < 0 ? s : s.substring(0, i);
        }

        function getFunctionString(functionSignature: ts.Signature) {
            let returnValue = "";

            let returnType = checker.getReturnTypeOfSignature(functionSignature);

            if (returnType.flags & ts.TypeFlags.NumberLike)
                returnValue = "return 0";
            else if (returnType.flags & ts.TypeFlags.StringLike)
                returnValue = "return \"\"";
            else if (returnType.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral))
                returnValue = python ? "return False" : "return false";

            if (python) {
                let functionArgument = `(${functionSignature.parameters.map(p => p.name).join(', ')})`;
                let n = fnName || "fn";
                if (functionCount++ > 0) n += functionCount;
                n = snakify(n);
                n = getUniqueName(n)
                preStmt += `def ${n}${functionArgument}:\n${PY_INDENT}${returnValue || "pass"}\n`;
                return n;
            } else {
                let functionArgument = "()";
                let displayParts = (ts as any).mapToDisplayParts((writer: ts.DisplayPartsSymbolWriter) => {
                    checker.getSymbolDisplayBuilder().buildSignatureDisplay(functionSignature, writer);
                });
                let displayPartsStr = ts.displayPartsToString(displayParts);
                functionArgument = displayPartsStr.substr(0, displayPartsStr.lastIndexOf(":"));
                return `function ${functionArgument} {\n    ${returnValue}\n}`;
            }
        }

        function emitFn(n: string): string {
            if (python) {
                n = n || "fn"
                n = snakify(n);
                n = getUniqueName(n)
                preStmt += `def ${n}():\n${PY_INDENT}pass\n`;
                return n;
            } else return `function () {}`;
        }
    }

    function getTsSymbolFromPxtSymbol(pxtSym: SymbolInfo, location: ts.Node, meaning: SymbolFlags): ts.Symbol | null {
        const checker = service && service.getProgram().getTypeChecker();
        if (!checker)
            return null
        const tsSymbols = checker.getSymbolsInScope(location, meaning)
        for (let tsSym of tsSymbols) {
            if (tsSym.escapedName.toString() === pxtSym.qName)
                return tsSym
        }
        return null
    }

    function getEnumMembers(t: Type): NodeArray<EnumMember> | undefined {
        const checker = service && service.getProgram().getTypeChecker();
        if (checker && t.symbol && t.symbol.declarations && t.symbol.declarations.length) {
            for (let i = 0; i < t.symbol.declarations.length; i++) {
                const decl = t.symbol.declarations[i];
                if (decl.kind === SK.EnumDeclaration) {
                    const enumDeclaration = decl as EnumDeclaration;
                    return enumDeclaration.members
                }
            }
        }
        return undefined
    }

    function enumMemberToQName(tc: TypeChecker, e: EnumMember) {
        if (e.name.kind === SK.Identifier) {
            return tc.getFullyQualifiedName(tc.getSymbolAtLocation(e.name));
        }
        return undefined
    }

    function getDefaultEnumValue(t: Type, python: boolean): string {
        // Note: AFAIK this is NOT guranteed to get the same default as you get in
        // blocks. That being said, it should get the first declared value. Only way
        // to guarantee an API has the same default in blocks and in TS is to actually
        // set a default on the parameter in its comment attributes
        const checker = service && service.getProgram().getTypeChecker();
        const members = getEnumMembers(t)
        for (const member of members) {
            if (member.name.kind === SK.Identifier) {
                const fullName = enumMemberToQName(checker, member)
                const pxtSym = lastApiInfo.apis.byQName[fullName]
                if (pxtSym) {
                    if (pxtSym.attributes.alias)
                        // use pyAlias if python; or default to alias
                        return (python && pxtSym.attributes.pyAlias) || pxtSym.attributes.alias; // prefer alias
                    return python ? pxtSym.pyQName : pxtSym.qName
                }
                else
                    return fullName
            }
        }

        return "0";
    }
}
