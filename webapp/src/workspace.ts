/// <reference path="../../built/pxtlib.d.ts" />
/// <reference path="../../built/pxteditor.d.ts" />
/// <reference path="../../built/pxtwinrt.d.ts" />

import * as db from "./db";
import * as core from "./core";
import * as data from "./data";
import * as browserworkspace from "./browserworkspace"
import * as fileworkspace from "./fileworkspace"
import * as memoryworkspace from "./memoryworkspace"
import * as iframeworkspace from "./iframeworkspace"
import * as cloudsync from "./cloudsync"
import * as indexedDBWorkspace from "./idbworkspace";
import * as compiler from "./compiler"
import * as auth from "./auth"
import * as cloud from "./cloud"

import U = pxt.Util;
import Cloud = pxt.Cloud;

// Avoid importing entire crypto-js
/* eslint-disable import/no-internal-modules */
const sha1 = require("crypto-js/sha1");

type Header = pxt.workspace.Header;
type ScriptText = pxt.workspace.ScriptText;
type WorkspaceProvider = pxt.workspace.WorkspaceProvider;
type InstallHeader = pxt.workspace.InstallHeader;
type File = pxt.workspace.File;

let allScripts: File[] = [];

let headerQ = new U.PromiseQueue();

let impl: WorkspaceProvider;
let implType: string;

export function getWorkspaceType(): string {
    return implType
}

function lookup(id: string) {
    return allScripts.find(x => x.header.id == id || x.header.path == id);
}

export function gitsha(data: string, encoding: "utf-8" | "base64" = "utf-8") {
    if (encoding == "base64") {
        const d = atob(data);
        return (sha1("blob " + d.length + "\u0000" + d) + "")
    } else
        return (sha1("blob " + U.toUTF8(data).length + "\u0000" + data) + "")
}

export function copyProjectToLegacyEditor(header: Header, majorVersion: number): Promise<Header> {
    if (!isBrowserWorkspace()) {
        return Promise.reject("Copy operation only works in browser workspace");
    }
    return browserworkspace.copyProjectToLegacyEditor(header, majorVersion);
}

export function setupWorkspace(id: string) {
    U.assert(!impl, "workspace set twice");
    pxt.log(`workspace: ${id}`);
    implType = id ?? "browser";
    switch (id) {
        case "fs":
        case "file":
            // Local file workspace, serializes data under target/projects/
            impl = fileworkspace.provider;
            break;
        case "mem":
        case "memory":
            impl = memoryworkspace.provider;
            break;
        case "iframe":
            // Iframe workspace, the editor relays sync messages back and forth when hosted in an iframe
            impl = iframeworkspace.provider;
            break;
        case "uwp":
            fileworkspace.setApiAsync(pxt.winrt.workspace.fileApiAsync);
            impl = pxt.winrt.workspace.getProvider(fileworkspace.provider);
            break;
        case "idb":
            impl = indexedDBWorkspace.provider;
            break;
        case "browser":
        default:
            impl = browserworkspace.provider
            break;
    }
}

async function switchToMemoryWorkspace(reason: string): Promise<void> {
    if (pxt.BrowserUtils.isWinRT()) {
        // windows app can fail on occasion, in particular when deleting projects;
        // ignore and keep trying to read from / write.
        return;
    }
    pxt.log(`workspace: error '${reason}', switching from ${implType} to memory workspace`);

    const expectedMemWs = pxt.appTarget.appTheme.disableMemoryWorkspaceWarning
        || impl === memoryworkspace.provider
        || pxt.shell.isSandboxMode() || pxt.shell.isReadOnly() || pxt.BrowserUtils.isIFrame();

    pxt.tickEvent(`workspace.syncerror`, {
        ws: implType,
        reason: reason,
        expected: expectedMemWs ? 1 : 0
    });

    if (!expectedMemWs) {
        await core.confirmAsync({
            header: lf("Warning! Project Auto-Save Disabled"),
            body: lf("We are unable to save your projects at this time. You can still manually save your project via direct download, or sharing your project."),
            agreeLbl: lf("Continue"),
            headerIcon: "warning",
            agreeClass: "cancel",
            agreeIcon: "cancel",
            helpUrl: "/browsers/no-auto-save",
            className: "auto-save-disabled-warning",
            hasCloseIcon: true,
        });
    }

    impl = memoryworkspace.provider;
    implType = "mem";
}

export function getHeaders(withDeleted = false) {
    maybeSyncHeadersAsync();
    const cloudUserId = auth.userProfile()?.id;
    let r = allScripts.map(e => e.header).filter(h =>
        (withDeleted || !h.isDeleted) &&
        !h.isBackup &&
        !h.isSkillmapProject &&
        (!h.cloudUserId || h.cloudUserId === cloudUserId))
    r.sort((a, b) => {
        const aTime = a.cloudUserId ? Math.min(a.cloudLastSyncTime, a.modificationTime) : a.modificationTime
        const bTime = b.cloudUserId ? Math.min(b.cloudLastSyncTime, b.modificationTime) : b.modificationTime
        return bTime - aTime
    })
    return r
}

export function makeBackupAsync(h: Header, text: ScriptText): Promise<Header> {
    let h2 = U.flatClone(h)
    h2.id = U.guidGen()

    delete h2._rev
    delete (h2 as any)._id
    h2.isBackup = true;

    return importAsync(h2, text)
        .then(() => {
            h.backupRef = h2.id;
            return forceSaveAsync(h2);
        })
        .then(() => h2)
}


export function restoreFromBackupAsync(h: Header) {
    if (!h.backupRef || h.isDeleted) return Promise.resolve();

    const refId = h.backupRef;
    return getTextAsync(refId)
        .then(files => {
            delete h.backupRef;
            return forceSaveAsync(h, files);
        })
        .then(() => {
            const backup = getHeader(refId);
            backup.isDeleted = true;
            return forceSaveAsync(backup);
        })
        .catch(() => {
            delete h.backupRef;
            return forceSaveAsync(h);
        });
}

function cleanupBackupsAsync() {
    const allHeaders = allScripts.map(e => e.header);
    const refMap: pxt.Map<boolean> = {};

    // Figure out which scripts have backups
    allHeaders.filter(h => h.backupRef).forEach(h => refMap[h.backupRef] = true);

    // Delete the backups that don't have any scripts referencing them
    return Promise.all(allHeaders.filter(h => (h.isBackup && !refMap[h.id])).map(h => {
        h.isDeleted = true;
        return forceSaveAsync(h);
    }));
}

export function getHeader(id: string) {
    maybeSyncHeadersAsync();
    let e = lookup(id)
    if (e && !e.header.isDeleted)
        return e.header
    return null
}

// this key is the max modificationTime value of the allHeaders
// it is used to track if allHeaders need to be refreshed (syncAsync)
let sessionID: string = "";
export function isHeadersSessionOutdated() {
    return pxt.storage.getLocal('workspacesessionid') != sessionID;
}
function maybeSyncHeadersAsync(): Promise<void> {
    if (isHeadersSessionOutdated()) // another tab took control
        return syncAsync().then(() => { })
    return Promise.resolve();
}
export function computeSessionId(hdrs: Header[]): string {
    // use # of scripts + time of last mod as key
    return hdrs.length + ' ' + hdrs
        .map(h => h.modificationTime)
        .reduce((l, r) => Math.max(l, r), 0)
        .toString()
}
function refreshHeadersSession() {
    sessionID = computeSessionId(allScripts.map(f => f.header))
    if (isHeadersSessionOutdated()) {
        pxt.storage.setLocal('workspacesessionid', sessionID);
        pxt.debug(`workspace: refreshed headers session to ${sessionID}`);
        pxt.data.invalidate("header:*");
        pxt.data.invalidate("text:*");
    }
}
// this is an identifier for the current frame
// in order to lock headers for editing
const workspaceID: string = pxt.Util.guidGen();
export function acquireHeaderSession(h: Header) {
    if (h)
        pxt.storage.setLocal('workspaceheadersessionid:' + h.id, workspaceID);
}
function clearHeaderSession(h: Header) {
    if (h)
        pxt.storage.removeLocal('workspaceheadersessionid:' + h.id);
}
export function isHeaderSessionOutdated(h: Header): boolean {
    if (!h) return false;
    const sid = pxt.storage.getLocal('workspaceheadersessionid:' + h.id);
    return sid && sid != workspaceID;
}
function checkHeaderSession(h: Header): void {
    if (isHeaderSessionOutdated(h)) {
        pxt.tickEvent(`workspace.conflict.header`);
        core.errorNotification(lf("This project is already opened elsewhere."))
        pxt.debug(`saved session ID: ${pxt.storage.getLocal('workspaceheadersessionid:' + h.id)}`)
        pxt.debug(`our session ID: ${workspaceID}`)
        pxt.Util.assert(false, "trying to access outdated session")
    }
}
// helps know when we last synced with the cloud (in seconds since epoch)
export function getHeaderLastCloudSync(h: Header): number {
    return h.cloudLastSyncTime || 0/*never*/
}
export function getLastCloudSync(): number {
    if (!auth.loggedIn())
        return 0;
    const userId = auth.userProfile()?.id;
    const cloudHeaders = getHeaders(true)
        .filter(h => h.cloudUserId && h.cloudUserId === userId);
    if (!cloudHeaders.length)
        return 0
    return Math.min(...cloudHeaders.map(getHeaderLastCloudSync))
}

export function initAsync() {
    if (!impl) {
        impl = browserworkspace.provider;
        implType = "browser";
    }

    return syncAsync()
        .then(state => cleanupBackupsAsync().then(() => state))
        .then(_ => {
            pxt.perf.recordMilestone("workspace init finished")
            return _
        })
}

export function getTextAsync(id: string): Promise<ScriptText> {
    return maybeSyncHeadersAsync()
        .then(() => {
            let e = lookup(id)
            if (!e)
                return Promise.resolve(null as ScriptText)
            if (e.text)
                return Promise.resolve(e.text)
            return headerQ.enqueue(id, () => impl.getAsync(e.header)
                .then(resp => {
                    if (!e.text) {
                        // otherwise we were beaten to it
                        e.text = fixupFileNames(resp.text);
                    }
                    e.version = resp.version;
                    return e.text
                }))
        })
}

export interface ScriptMeta {
    description: string;
    blocksWidth?: number;
    blocksHeight?: number;
}

// https://github.com/Microsoft/pxt-backend/blob/master/docs/sharing.md#anonymous-publishing
export function anonymousPublishAsync(h: Header, text: ScriptText, meta: ScriptMeta, screenshotUri?: string) {
    checkHeaderSession(h);

    const saveId = {}
    h.saveId = saveId
    let thumbnailBuffer: string;
    let thumbnailMimeType: string;
    if (screenshotUri) {
        const m = /^data:(image\/(png|gif));base64,([a-zA-Z0-9+/]+=*)$/.exec(screenshotUri);
        if (m) {
            thumbnailBuffer = m[3];
            thumbnailMimeType = m[1];
        }
    }
    const stext = JSON.stringify(text, null, 2) + "\n"
    const scrReq = {
        name: h.name,
        target: h.target,
        targetVersion: h.targetVersion,
        description: meta.description || lf("Made with ❤️ in {0}.", pxt.appTarget.title || pxt.appTarget.name),
        editor: h.editor,
        text: text,
        meta: {
            versions: pxt.appTarget.versions,
            blocksHeight: meta.blocksHeight,
            blocksWidth: meta.blocksWidth
        },
        thumbnailBuffer,
        thumbnailMimeType
    }
    pxt.debug(`publishing script; ${stext.length} bytes`)
    return Cloud.privatePostAsync("scripts", scrReq, /* forceLiveEndpoint */ true)
        .then((inf: Cloud.JsonScript) => {
            if (inf.shortid) inf.id = inf.shortid;
            h.pubId = inf.shortid
            h.pubCurrent = h.saveId === saveId
            h.meta = inf.meta;
            pxt.debug(`published; id /${h.pubId}`)
            return saveAsync(h)
                .then(() => inf)
        })
}

function fixupVersionAsync(e: File) {
    if (e.version !== undefined)
        return Promise.resolve()
    return impl.getAsync(e.header)
        .then(resp => {
            e.version = resp.version;
        })
}

export function forceSaveAsync(h: Header, text?: ScriptText, isCloud?: boolean): Promise<void> {
    clearHeaderSession(h);
    return saveAsync(h, text, isCloud);
}

interface Change<K, V> {
    kind: 'add' | 'del' | 'mod'
    key: K,
    oldVal?: V,
    newVal?: V,
}
interface ProjectChanges {
    header: Change<keyof Header, string>[],
    files: Change<string, number>[],
}
function computeChangeSummary(a: {header: Header, text: ScriptText}, b: {header: Header, text: ScriptText}): ProjectChanges {
    const aHdr = a.header || {} as Header
    const bHdr = b.header || {} as Header
    const aTxt = a.text || {}
    const bTxt = b.text || {}

    // headers
    type HeaderK = keyof Header
    const hdrKeys = U.unique([...Object.keys(aHdr), ...Object.keys(bHdr)], s => s) as HeaderK[]
    const hasObjChanged = (a: any, b: any) => JSON.stringify(a) !== JSON.stringify(b)
    const hasHdrChanged = (k: HeaderK) => hasObjChanged(aHdr[k], bHdr[k])
    const hdrChanges = hdrKeys.filter(hasHdrChanged)
    const hdrDels = hdrChanges.filter(k => (k in aHdr) && !(k in bHdr))
        .map(k => ({kind: 'del', key: k, oldVal: aHdr[k]}) as Change<HeaderK, string>)
    const hdrAdds = hdrChanges.filter(k => !(k in aHdr) && (k in bHdr))
        .map(k => ({kind: 'add', key: k, newVal: bHdr[k]}) as Change<HeaderK, string>)
    const hdrMods = hdrChanges.filter(k => (k in aHdr) && (k in bHdr))
        .map(k => ({kind: 'mod', key: k, oldVal: aHdr[k], newVal: bHdr[k]}) as Change<HeaderK, string>)

    // files
    const filenames = U.unique([...Object.keys(aTxt), ...Object.keys(bTxt)], s => s)
    const hasFileChanged = (filename: string) => aTxt[filename] !== bTxt[filename]
    const fileChanges = filenames.filter(hasFileChanged)
    const fileDels = fileChanges.filter(k => (k in aTxt) && !(k in bTxt) && !!b.text)
        .map(k => ({kind: 'del', key: k, oldVal: aTxt[k].length}) as Change<string, number>)
    const fileAdds = fileChanges.filter(k => !(k in aTxt) && (k in bTxt))
        .map(k => ({kind: 'add', key: k, newVal: bTxt[k].length}) as Change<string, number>)
    const fileMods = fileChanges.filter(k => (k in aTxt) && (k in bTxt))
        .map(k => ({kind: 'mod', key: k, oldVal: aTxt[k].length, newVal: bTxt[k].length}) as Change<string, number>)

    return {
        header: [...hdrDels, ...hdrAdds, ...hdrMods],
        files: [...fileDels, ...fileAdds, ...fileMods],
    }
}
// useful for debugging
function stringifyChangeSummary(diff: ProjectChanges): string {
    const indent = (s: string) => '\t' + s
    const changeToStr = (c: Change<any,any>) => `${c.kind} ${c.key}: (${c.oldVal || ''}) => (${c.newVal || ''})`
    let res = ''

    const hdrDels = diff.header.filter(k => k.kind === 'del')
    const hdrAdds = diff.header.filter(k => k.kind === 'add')
    const hdrMods = diff.header.filter(k => k.kind === 'mod')

    res += `HEADER (+${hdrAdds.length}-${hdrDels.length}~${hdrMods.length})`
    res += '\n'

    const hdrStrs = diff.header.map(changeToStr)
    res += hdrStrs.map(indent).join("\n")
    res += '\n'

    const fileDels = diff.files.filter(k => k.kind === 'del')
    const fileAdds = diff.files.filter(k => k.kind === 'add')
    const fileMods = diff.files.filter(k => k.kind === 'mod')

    res += `FILES (+${fileAdds.length}-${fileDels.length}~${fileMods.length})`
    res += '\n'
    const fileStrs = diff.files.map(changeToStr)
    res += fileStrs.map(indent).join("\n")
    res += '\n'

    return res;
}

export async function partialSaveAsync(id: string, filename: string, content: string): Promise<void> {
    const prev = lookup(id);
    if (!prev) {
        pxt.log("Failed to save to unknown project: " + id);
        pxt.tickEvent(`workspace.invalidSaveToUnknownProject`);
        return;
    }
    const newTxt = {...await getTextAsync(id)}
    newTxt[filename] = content;
    return saveAsync(prev.header, newTxt);
}

export async function saveAsync(h: Header, text?: ScriptText, fromCloudSync?: boolean): Promise<void> {
    pxt.debug(`workspace.saveAsync ${dbgHdrToString(h)}`)
    if (h.isDeleted)
        clearHeaderSession(h);
    checkHeaderSession(h);

    U.assert(h.target == pxt.appTarget.id);

    if (h.temporary)
        return Promise.resolve()

    let e = lookup(h.id)
    const newSave = !e
    if (newSave) {
        e = {
            header: h,
            text,
            version: null
        }
        allScripts.push(e)
    }

    const hasUserFileChanges = () => {
        // we see lots of frequent "saves" that don't come from real changes made by the user. This
        // causes problems for cloud sync since this can cause us to think the user is making when
        // just reading a project. The "correct" solution would be to have a full history and .gitignore
        // file.
        if (newSave) {
            // new project
            return true
        }
        const prevProj = e
        const allChanges = computeChangeSummary(prevProj, {header: h, text})
        const ignoredFiles = [GIT_JSON, pxt.SIMSTATE_JSON, pxt.SERIAL_EDITOR_FILE]
        const ignoredHeaderFields: (keyof Header)[] = ['recentUse', 'modificationTime', 'cloudCurrent', '_rev', '_id' as keyof Header, 'cloudVersion']
        const userChanges: ProjectChanges = {
            header: allChanges.header.filter(f => ignoredHeaderFields.indexOf(f.key) < 0),
            files: allChanges.files.filter(f => ignoredFiles.indexOf(f.key) < 0)
        }

        const hasUserChanges = userChanges.header.length > 0 || userChanges.files.length > 0

        if (hasUserChanges) {
            pxt.debug("user changes:")
            pxt.debug(stringifyChangeSummary(userChanges))
        }

        return hasUserChanges;
    }
    const isHeaderOnlyChange = !fromCloudSync && !text;
    const isUserChange = !fromCloudSync
        && (h.isDeleted || text && hasUserFileChanges())
    if (isHeaderOnlyChange || isUserChange) {
        h.pubCurrent = false
        h.cloudCurrent = false
        h.modificationTime = U.nowSeconds();
        h.targetVersion = h.targetVersion || "0.0.0";

        // cloud user association
        if (auth.hasIdentity() && auth.loggedIn()) {
            h.cloudUserId = auth.userProfile()?.id
        }
    }

    if (!fromCloudSync)
        h.recentUse = U.nowSeconds()

    if (!newSave) {
        // persist header changes to our local cache, but keep the old
        // reference around because (unfortunately) other layers (e.g. package.ts)
        // assume the reference is stable per id.
        Object.assign(e.header, h);
        // Delete keys from `e.header` that don't exist in `h`. This will clear cloud state
        // from the header in the case where the project is being exported to local from cloud.
        Object.keys(e.header)
            .filter(key => h[key as keyof Header] === undefined)
            .forEach(key => delete e.header[key as keyof Header]);
        h = e.header;
    }
    if (text)
        e.text = text
    if (text || h.isDeleted) {
        h.saveId = null
    }

    // check if we have dynamic boards, store board info for home page rendering
    if (text && pxt.appTarget.simulator && pxt.appTarget.simulator.dynamicBoardDefinition) {
        const pxtjson = pxt.Package.parseAndValidConfig(text[pxt.CONFIG_NAME]);
        if (pxtjson && pxtjson.dependencies)
            h.board = Object.keys(pxtjson.dependencies)
                .filter(p => !!pxt.bundledSvg(p))[0];
    }

    return headerQ.enqueue<void>(h.id, async () => {
        await fixupVersionAsync(e);
        let ver: any;

        const toWrite = text ? e.text : null;

        try {
            ver = await impl.setAsync(h, e.version, toWrite);
        } catch (e) {
            // Write failed; use in memory db.
            await switchToMemoryWorkspace("write failed");
            ver = await impl.setAsync(h, e.version, toWrite);
        }
        if (!ver && text) {
            // write failed due to conflict
            pxt.debug('write rejected due to version conflict!')
        }

        if (text) {
            e.version = ver;
        }

        if (isUserChange) {
            h.pubCurrent = false;
            h.cloudCurrent = false;
            h.saveId = null;
        }

        if (text || h.isDeleted) {
            pxt.data.invalidate("text:" + h.id);
            pxt.data.invalidate("pkg-git-status:" + h.id);
        }
        data.invalidateHeader("header", h);
        if (newSave) {
            // the count of headers has changed
            pxt.data.invalidate("headers:");
        }

        refreshHeadersSession();
    });
}

function computePath(h: Header) {
    let path = h.name.replace(/[^a-zA-Z0-9]+/g, " ").trim().replace(/ /g, "-")
    if (!path)
        path = "Untitled"; // do not translate
    if (lookup(path)) {
        let n = 2
        while (lookup(path + "-" + n))
            n++;
        path += "-" + n
    }

    return path
}

export function importAsync(h: Header, text: ScriptText, isCloud = false) {
    h.path = computePath(h)
    return forceSaveAsync(h, text, isCloud)
}

export function installAsync(h0: InstallHeader, text: ScriptText, dontOverwriteID = false) {
    U.assert(h0.target == pxt.appTarget.id);

    const h = <Header>h0
    if (!dontOverwriteID) h.id = ts.pxtc.Util.guidGen();
    h.recentUse = U.nowSeconds()
    h.modificationTime = h.recentUse;

    const cfg: pxt.PackageConfig = pxt.Package.parseAndValidConfig(text[pxt.CONFIG_NAME]);
    if (cfg && cfg.preferredEditor) {
        h.editor = cfg.preferredEditor
        pxt.shell.setEditorLanguagePref(cfg.preferredEditor);
    }

    return pxt.github.cacheProjectDependenciesAsync(cfg)
        .then(() => importAsync(h, text))
        .then(() => h);
}

export async function duplicateAsync(h: Header, newName?: string): Promise<Header> {
    const text = await getTextAsync(h.id);

    if (!newName)
        newName = createDuplicateName(h);

    let newHdr = U.flatClone(h)

    const dupText = U.flatClone(text);
    newHdr.id = U.guidGen()
    newHdr.name = newName;
    const cfg = JSON.parse(text[pxt.CONFIG_NAME]) as pxt.PackageConfig;
    cfg.name = newHdr.name;
    dupText[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);

    delete newHdr._rev;
    delete (newHdr as any)._id;
    delete newHdr.githubCurrent;
    delete newHdr.githubId;
    delete newHdr.githubTag;

    if (newHdr.cloudVersion) {
        pxt.tickEvent(`identity.duplicatingCloudProject`);
    }

    // drop cloud-related local metadata
    newHdr = cloud.excludeLocalOnlyMetadataFields(newHdr)

    return importAsync(newHdr, dupText)
        .then(() => newHdr)
}

export function createDuplicateName(h: Header) {
    let reducedName = h.name.indexOf("#") > -1 ?
        h.name.substring(0, h.name.lastIndexOf('#')).trim() : h.name;
    let names = U.toDictionary(allScripts.filter(e => !e.header.isDeleted), e => e.header.name)
    let n = 2
    while (names.hasOwnProperty(reducedName + " #" + n))
        n++
    return reducedName + " #" + n;
}

export function saveScreenshotAsync(h: Header, data: string, icon: string) {
    checkHeaderSession(h);
    return impl.saveScreenshotAsync
        ? impl.saveScreenshotAsync(h, data, icon)
        : Promise.resolve();
}

export function fixupFileNames(txt: ScriptText) {
    if (!txt) return txt;
    ["kind.json", "yelm.json"].forEach(oldName => {
        if (!txt[pxt.CONFIG_NAME] && txt[oldName]) {
            txt[pxt.CONFIG_NAME] = txt[oldName]
            delete txt[oldName]
        }
    })
    return txt
}


const scriptDlQ = new U.PromiseQueue();
const scripts = new db.Table("script"); // cache for published scripts
export async function getPublishedScriptAsync(id: string) {
    if (pxt.github.isGithubId(id))
        id = pxt.github.normalizeRepoId(id)
    const config = await pxt.packagesConfigAsync()
    const eid = encodeURIComponent(pxt.github.upgradedPackageId(config, id))
    return await scriptDlQ.enqueue(eid, async () => {
        let files: ScriptText
        try {
            files = (await scripts.getAsync(eid)).files
        } catch {
            if (pxt.github.isGithubId(id)) {
                files = (await pxt.github.downloadPackageAsync(id, config)).files
            } else {
                files = await (Cloud.downloadScriptFilesAsync(id)
                    .catch(core.handleNetworkError))
            }
            try {
                await scripts.setAsync({ id: eid, files: files })
            }
            catch (e) {
                // Don't fail if the indexeddb fails, but log it
                pxt.log("Unable to cache script in DB");
            }
        }
        return fixupFileNames(files)
    })
}

export enum PullStatus {
    NoSourceControl,
    UpToDate,
    GotChanges,
    NeedsCommit,
    BranchNotFound
}

const GIT_JSON = pxt.github.GIT_JSON
type GitJson = pxt.github.GitJson

export async function hasPullAsync(hd: Header) {
    return (await pullAsync(hd, true)) == PullStatus.GotChanges
}

export async function pullAsync(hd: Header, checkOnly = false) {
    let files = await getTextAsync(hd.id)
    await recomputeHeaderFlagsAsync(hd, files)
    let gitjsontext = files[GIT_JSON]
    if (!gitjsontext)
        return PullStatus.NoSourceControl
    let gitjson = JSON.parse(gitjsontext) as GitJson
    let parsed = pxt.github.parseRepoId(gitjson.repo)
    const branch = parsed.tag;
    const sha = await pxt.github.getRefAsync(parsed.slug, branch)
    if (!sha) {
        // 404: branch does not exist, repo is gone or no rights to access repo
        // try to get the list of heads to see if we can access the project
        const heads = await pxt.github.listRefsAsync(parsed.slug, "heads");
        if (heads && heads.length)
            return PullStatus.BranchNotFound;
        else
            return PullStatus.NoSourceControl; // something is wrong
    } else if (sha == gitjson.commit.sha)
        return PullStatus.UpToDate
    if (checkOnly)
        return PullStatus.GotChanges
    try {
        await githubUpdateToAsync(hd, { repo: gitjson.repo, sha, files, tryDiff3: true })
        return PullStatus.GotChanges
    } catch (e) {
        if (e.isMergeError)
            return PullStatus.NeedsCommit
        else throw e
    }
}

export async function revertAllAsync(hd: Header) {
    const files = await getTextAsync(hd.id)
    const gitjsontext = files[GIT_JSON]
    if (!gitjsontext)
        return PullStatus.NoSourceControl
    const gitjson = JSON.parse(gitjsontext) as GitJson
    const parsed = pxt.github.parseRepoId(hd.githubId)
    const commit = gitjson.commit;
    const configEntry = pxt.github.lookupFile(parsed, commit, pxt.CONFIG_NAME);
    const config = pxt.Package.parseAndValidConfig(configEntry && configEntry.blobContent);
    if (!config)
        return PullStatus.NoSourceControl

    const revertedFiles: pxt.Map<string> = {};
    revertedFiles[GIT_JSON] = gitjsontext;
    revertedFiles[pxt.CONFIG_NAME] = configEntry.blobContent;
    for (const f of config.files.concat(config.testFiles)) {
        const entry = pxt.github.lookupFile(parsed, commit, f);
        if (!entry || entry.blobContent === undefined) {
            pxt.log(`cannot revert ${f}, corrupted based commit`)
            return PullStatus.NoSourceControl
        }
        revertedFiles[f] = entry.blobContent;
    }
    // save updated file content
    await forceSaveAsync(hd, revertedFiles)
    return PullStatus.UpToDate;
}

export async function hasMergeConflictMarkersAsync(hd: Header): Promise<boolean> {
    const files = await getTextAsync(hd.id)
    return !!Object.keys(files).find(k => pxt.diff.hasMergeConflictMarker(files[k]));
}

export async function prAsync(hd: Header, commitId: string, msg: string) {
    let parsed = pxt.github.parseRepoId(hd.githubId)
    // merge conflict - create a Pull Request
    const branchName = await pxt.github.getNewBranchNameAsync(parsed.slug, "merge-")
    await pxt.github.createNewBranchAsync(parsed.slug, branchName, commitId)
    const url = await pxt.github.createPRFromBranchAsync(parsed.slug, parsed.tag, branchName, msg)
    // force user back to master - we will instruct them to merge PR in github.com website
    // and sync here to get the changes
    let headCommit = await pxt.github.getRefAsync(parsed.slug, parsed.tag)
    await githubUpdateToAsync(hd, {
        repo: hd.githubId,
        sha: headCommit,
        files: {}
    })
    return url
}

export function bumpedVersion(cfg: pxt.PackageConfig) {
    let v = pxt.semver.parse(cfg.version, "0.0.0")
    v.patch++
    return pxt.semver.stringify(v)
}

export async function bumpAsync(hd: Header, newVer = "") {
    checkHeaderSession(hd);

    const files = await getTextAsync(hd.id)
    const cfg = pxt.Package.parseAndValidConfig(files[pxt.CONFIG_NAME]);
    cfg.version = newVer || bumpedVersion(cfg)
    const releaseTag = "v" + cfg.version;

    // if any other github repo is referenced, unbound their version
    // those extensions are part of the same repo and their version will be resolved
    // at load time
    if (cfg.dependencies) {
        const gh = pxt.github.parseRepoId(hd.githubId);
        Object.keys(cfg.dependencies).forEach(k => {
            const ver = cfg.dependencies[k];
            const ghid = /^github:/.test(ver) && pxt.github.parseRepoId(ver);
            if (ghid && gh.slug === ghid.slug) {
                cfg.dependencies[k] = `github:${pxt.github.join(gh.slug, ghid.fileName)}`
                pxt.debug(`patching dep ${k} to ${cfg.dependencies[k]}`)
            }
        })
    }

    files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    await saveAsync(hd, files)
    return await commitAsync(hd, {
        message: cfg.version,
        createRelease: releaseTag,
        binaryJs: true
    })
}

export interface CommitOptions {
    message?: string;
    createRelease?: string;
    filenamesToCommit?: string[];
    binaryJs?: boolean;
    // render blocks to png
    blocksScreenshotAsync?: () => Promise<string>;
    // render blocks diff to png
    blocksDiffScreenshotAsync?: () => Promise<string>;
}

const BLOCKS_PREVIEW_PATH = ".github/makecode/blocks.png";
const BLOCKSDIFF_PREVIEW_PATH = ".github/makecode/blocksdiff.png";
const BINARY_JS_PATH = "assets/js/binary.js";
const VERSION_TXT_PATH = "assets/version.txt";
export async function commitAsync(hd: Header, options: CommitOptions = {}) {
    await cloudsync.ensureGitHubTokenAsync();

    let files = await getTextAsync(hd.id)
    let gitjsontext = files[GIT_JSON]
    if (!gitjsontext)
        U.userError(lf("Not a git extension."))
    let gitjson = JSON.parse(gitjsontext) as GitJson
    let parsed = pxt.github.parseRepoId(gitjson.repo)
    let cfg = pxt.Package.parseAndValidConfig(files[pxt.CONFIG_NAME]);
    let treeUpdate: pxt.github.CreateTreeReq = {
        base_tree: gitjson.commit.tree.sha,
        tree: []
    }
    const filenames = options.filenamesToCommit || pxt.allPkgFiles(cfg)
    const ignoredFiles = [GIT_JSON, pxt.SIMSTATE_JSON, pxt.SERIAL_EDITOR_FILE]
    for (const path of filenames.filter(f => ignoredFiles.indexOf(f) < 0)) {
        const fileContent = files[path];
        await addToTree(path, fileContent);
    }

    if (treeUpdate.tree.length == 0)
        U.userError(lf("Nothing to commit!"))

    // add screenshots
    let blocksDiffSha: string;
    if (options
        && treeUpdate.tree.find(e => e.path == pxt.MAIN_BLOCKS)) {
        if (options.blocksScreenshotAsync) {
            const png = await options.blocksScreenshotAsync();
            if (png)
                await addToTree(BLOCKS_PREVIEW_PATH, png);
        }
        if (options.blocksDiffScreenshotAsync) {
            const png = await options.blocksDiffScreenshotAsync();
            if (png)
                blocksDiffSha = await addToTree(BLOCKSDIFF_PREVIEW_PATH, png);
        }
    }

    // add compiled javascript to be run in github pages
    if (pxt.appTarget.appTheme.githubCompiledJs
        && options.binaryJs
        && (!parsed.tag || parsed.tag == "master")) {
        const v = cfg.version || "0.0.0";
        const opts: compiler.CompileOptions = {
            jsMetaVersion: v
        }
        const compileResp = await compiler.compileAsync(opts);
        if (compileResp && compileResp.success && compileResp.outfiles[pxtc.BINARY_JS]) {
            await addToTree(BINARY_JS_PATH, compileResp.outfiles[pxtc.BINARY_JS]);
            await addToTree(VERSION_TXT_PATH, v);
            // ensure template files are up to date
            if (!cfg.disableTargetTemplateFiles) {
                const templates = pxt.template.targetTemplateFiles();
                if (templates) {
                    for (const fn of Object.keys(templates)) {
                        await addToTree(fn, templates[fn]);
                    }
                }
            }
        }
    }

    // create tree
    let treeId = await pxt.github.createObjectAsync(parsed.slug, "tree", treeUpdate)
    let commit: pxt.github.CreateCommitReq = {
        message: options.message || lf("Update {0}", treeUpdate.tree.map(e => e.path).filter(f => !/\.github\/makecode\//.test(f)).join(", ")),
        parents: [gitjson.commit.sha],
        tree: treeId
    }
    // we are in a merge
    if (gitjson.mergeSha)
        commit.parents.push(gitjson.mergeSha)
    let commitId = await pxt.github.createObjectAsync(parsed.slug, "commit", commit)
    let ok = await pxt.github.fastForwardAsync(parsed.slug, parsed.tag, commitId)
    let newCommit = commitId
    if (!ok)
        newCommit = await pxt.github.mergeAsync(parsed.slug, parsed.tag, commitId)

    if (newCommit == null) {
        return commitId
    } else {
        pxt.data.invalidate("gh-commits:*"); // invalid any cached commits
        // if we created a block preview, add as comment
        if (blocksDiffSha) {
            await pxt.github.postCommitComment(
                parsed.slug,
                commitId,
                `![${lf("Difference between blocks")}](https://raw.githubusercontent.com/${pxt.github.join(parsed.slug, commitId, parsed.fileName, BLOCKSDIFF_PREVIEW_PATH)}`);
        }

        await githubUpdateToAsync(hd, {
            repo: gitjson.repo,
            sha: newCommit,
            files,
            saveTag: options.createRelease
        })
        if (options.createRelease) {
            await pxt.github.createReleaseAsync(parsed.slug, options.createRelease, newCommit)
            // ensure pages are on
            await pxt.github.enablePagesAsync(parsed.slug);
            // clear the cloud cache
            await pxt.github.listRefsAsync(parsed.slug, "tags", true, true);
        }
        return ""
    }

    async function addToTree(path: string, content: string): Promise<string> {
        const data = {
            content: content,
            encoding: "utf-8"
        } as pxt.github.CreateBlobReq;
        if (path == pxt.CONFIG_NAME)
            data.content = prepareConfigForGithub(data.content, !!options.createRelease);
        const m = /^data:([^;]+);base64,/.exec(content);
        if (m) {
            data.encoding = "base64";
            data.content = content.substr(m[0].length);
        }
        const sha = gitsha(data.content, data.encoding)
        const ex = pxt.github.lookupFile(parsed, gitjson.commit, path)
        let res: string;
        if (!ex || ex.sha != sha) {
            // look for unfinished merges
            if (data.encoding == "utf-8" &&
                pxt.diff.hasMergeConflictMarker(data.content))
                throw mergeConflictMarkerError();
            res = await pxt.github.createObjectAsync(parsed.slug, "blob", data)
            if (data.encoding == "utf-8")
                U.assert(res == sha, `sha not matching ${res} != ${sha}`)
            const gitPath = pxt.github.join(parsed.fileName, path)
            treeUpdate.tree.push({
                "path": gitPath,
                "mode": "100644",
                "type": "blob",
                "sha": res,
                "url": undefined
            })
        }
        return res;
    }
}

export async function restoreCommitAsync(hd: Header, commit: pxt.github.CommitInfo) {
    await cloudsync.ensureGitHubTokenAsync();

    const files = await getTextAsync(hd.id)
    const gitjsontext = files[GIT_JSON]
    const gitjson = JSON.parse(gitjsontext) as GitJson
    const parsed = pxt.github.parseRepoId(gitjson.repo)
    const date = new Date(Date.parse(commit.committer.date));
    const restored: pxt.github.CreateCommitReq = {
        message: lf("Restore '{0} {1}'", date.toLocaleString(), commit.message),
        parents: [gitjson.commit.sha],
        tree: commit.tree.sha
    }

    const commitId = await pxt.github.createObjectAsync(parsed.slug, "commit", restored)
    await pxt.github.fastForwardAsync(parsed.slug, parsed.tag, commitId)
    await githubUpdateToAsync(hd, {
        repo: gitjson.repo,
        sha: commitId,
        files
    })
}

export async function mergeUpstreamAsync(hd: Header, base: string) {
    // pull in all the changes
    return Promise.resolve();
}

interface UpdateOptions {
    repo: string;
    sha: string;
    files: pxt.Map<string>;
    saveTag?: string;
    justJSON?: boolean;
    tryDiff3?: boolean;
}

function mergeError() {
    const e = new Error("Merge error");
    (e as any).isMergeError = true
    return e
}

function mergeConflictMarkerError() {
    const e = new Error("Merge conflict marker error");
    (e as any).isMergeConflictMarkerError = true
    return e
}

async function githubUpdateToAsync(hd: Header, options: UpdateOptions) {
    const { repo, sha, files, justJSON } = options
    const parsed = pxt.github.parseRepoId(repo)
    const commit = await pxt.github.getCommitAsync(parsed.slug, sha)
    let gitjson: GitJson = JSON.parse(files[GIT_JSON] || "{}")

    if (!gitjson.commit) {
        gitjson = {
            repo: repo,
            commit: null
        }
    }

    const downloadedFiles: pxt.Map<boolean> = {}
    let conflicts = 0;
    let blocksNeedDecompilation = false;

    const downloadAsync = async (path: string) => {
        downloadedFiles[path] = true
        const treeEnt = pxt.github.lookupFile(parsed, commit, path)
        const oldEnt = pxt.github.lookupFile(parsed, gitjson.commit, path)
        const hasChanges = files[path] != null && (!oldEnt || oldEnt.blobContent != files[path])
        if (!treeEnt) {
            // file in pxt.json but not in git:
            // changes were merged from the cloud but not pushed yet
            if (options.tryDiff3 && hasChanges)
                return files[path];
            if (!justJSON)
                files[path] = ""
            return ""
        }
        let text = oldEnt ? oldEnt.blobContent : files[path]
        if (text != null && gitsha(text) == treeEnt.sha) {
            treeEnt.blobContent = text
            if (!options.tryDiff3 && !options.justJSON)
                files[path] = text
            return text
        }
        text = await pxt.github.downloadTextAsync(parsed.fullName, sha, path)
        treeEnt.blobContent = text
        if (gitsha(text) != treeEnt.sha
            // Try adding UTF-8 BOM; this can be stripped over web requests
            && gitsha(`\uFEFF${text}`) !== treeEnt.sha) {
            U.userError(lf("Corrupt SHA1 on download of '{0}'.", path))
        }
        if (options.tryDiff3 && hasChanges) {
            if (path == pxt.CONFIG_NAME) {
                text = pxt.diff.mergeDiff3Config(files[path], oldEnt.blobContent, treeEnt.blobContent);
                if (!text) // merge failed?
                    throw mergeError()
            } else if (/\.blocks$/.test(path)) {
                // blocks file, try merging the blocks or clear it so that ts merge picks it up
                const d3 = pxt.blocks.mergeXml(files[path], oldEnt.blobContent, treeEnt.blobContent);
                // if xml merge fails, leave an empty xml payload to force decompilation
                blocksNeedDecompilation = blocksNeedDecompilation || !d3;
                text = d3 || "";
            } else if (path == BINARY_JS_PATH || path == VERSION_TXT_PATH || path == pxt.TUTORIAL_INFO_FILE || path == pxt.ASSETS_FILE) {
                // local build wins, does not matter
                text = files[path];
            } else {
                const d3 = pxt.diff.diff3(files[path], oldEnt.blobContent, treeEnt.blobContent, lf("local changes"), lf("remote changes (pulled from Github)"))
                if (!d3) // merge failed?
                    throw mergeError()
                conflicts += d3.numConflicts
                if (d3.numConflicts && !/\.ts$/.test(path)) // only allow conflict markers in typescript files
                    throw mergeError()
                text = d3.merged
            }
        }
        if (!justJSON)
            files[path] = text
        return text
    }

    // we need to keep the old cfg to maintain the github id -> local workspace id
    const oldCfg = pxt.Package.parseAndValidConfig(files[pxt.CONFIG_NAME])
    const cfgText = await downloadAsync(pxt.CONFIG_NAME)
    let cfg = pxt.Package.parseAndValidConfig(cfgText);
    // invalid cfg
    if (!cfg) {
        if (hd) // not importing
            U.userError(lf("Invalid pxt.json file."));
        pxt.debug(`github: reconstructing pxt.json`)
        cfg = pxt.diff.reconstructConfig(parsed, files, commit, pxt.appTarget.blocksprj || pxt.appTarget.tsprj);
        files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    }
    // patch the github references back to local workspaces
    if (oldCfg) {
        let ghupdated = 0;
        Object.keys(cfg.dependencies)
            // find github references that are also in the original version
            .filter(k => /^github:/.test(cfg.dependencies[k]) && oldCfg.dependencies[k])
            .forEach(k => {
                const gid = pxt.github.parseRepoId(cfg.dependencies[k]);
                if (gid) {
                    const wks = oldCfg.dependencies[k];
                    cfg.dependencies[k] = wks;
                    ghupdated++;
                }
            })
        if (ghupdated)
            files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    }

    for (const fn of pxt.allPkgFiles(cfg).slice(1))
        await downloadAsync(fn)

    if (!cfg.name) {
        cfg.name = (parsed.fileName || parsed.project || parsed.fullName).replace(/[^\w\-]/g, "");
        if (!justJSON)
            files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    }

    if (!justJSON) {
        // if any block needs decompilation, don't allow merge error markers
        if (blocksNeedDecompilation && conflicts)
            throw mergeError()
        for (let k of Object.keys(files)) {
            if (k[0] != "." && !downloadedFiles[k])
                delete files[k]
        }
    }

    commit.tag = options.saveTag
    gitjson.mergeSha = undefined
    gitjson.commit = commit
    files[GIT_JSON] = JSON.stringify(gitjson, null, 4)

    /**
     * If the repo was last opened in this target, use that version number in the header;
     * otherwise, use current target version to avoid mismatched updates.
     */
    const targetVersionToUse = (cfg.targetVersions?.targetId === pxt.appTarget.id && cfg.targetVersions.target) ?
        cfg.targetVersions.target : pxt.appTarget.versions.target;

    if (!hd) {
        hd = await installAsync({
            name: cfg.name,
            githubId: repo,
            pubId: "",
            pubCurrent: false,
            meta: {},
            editor: pxt.BLOCKS_PROJECT_NAME,
            target: pxt.appTarget.id,
            targetVersion: targetVersionToUse,
        }, files)
    } else {
        hd.name = cfg.name
        await forceSaveAsync(hd, files)
    }

    return hd
}

export async function exportToGithubAsync(hd: Header, repoid: string) {
    const parsed = pxt.github.parseRepoId(repoid);
    const pfiles = pxt.template.packageFiles(hd.name);
    await pxt.github.putFileAsync(parsed.fullName, ".gitignore", pfiles[".gitignore"]);
    const sha = await pxt.github.getRefAsync(parsed.slug, parsed.tag)
    const commit = await pxt.github.getCommitAsync(parsed.slug, sha)
    const files = await getTextAsync(hd.id)
    files[GIT_JSON] = JSON.stringify({
        repo: repoid,
        commit
    })

    // assign ids to blockly blocks
    const mainBlocks = files[pxt.MAIN_BLOCKS];
    if (mainBlocks) {
        const ws = pxt.blocks.loadWorkspaceXml(mainBlocks, true);
        if (ws) {
            const mainBlocksWithIds = pxt.blocks.saveWorkspaceXml(ws, true);
            if (mainBlocksWithIds)
                files[pxt.MAIN_BLOCKS] = mainBlocksWithIds;
        }
    }
    // save updated files
    await forceSaveAsync(hd, files);
    await initializeGithubRepoAsync(hd, repoid, false, true);
    // race condition, don't pull right away
    // await pullAsync(hd);
}


// to be called after loading header in a editor
export async function recomputeHeaderFlagsAsync(h: Header, files: ScriptText) {
    checkHeaderSession(h);

    h.githubCurrent = false

    const gitjson: GitJson = JSON.parse(files[GIT_JSON] || "{}")

    h.githubId = gitjson && gitjson.repo
    h.githubTag = gitjson && gitjson.commit && gitjson.commit.tag

    if (!h.githubId)
        return

    if (!gitjson.commit || !gitjson.commit.tree)
        return

    const parsed = pxt.github.parseRepoId(h.githubId);
    let isCurrent = true
    let needsBlobs = false
    for (let k of Object.keys(files)) {
        if (k == GIT_JSON || k == pxt.SIMSTATE_JSON || k == pxt.SERIAL_EDITOR_FILE)
            continue
        let treeEnt = pxt.github.lookupFile(parsed, gitjson.commit, k)
        if (!treeEnt || treeEnt.type != "blob") {
            isCurrent = false
            continue
        }
        if (treeEnt.blobContent == null)
            needsBlobs = true
        let content = files[k];
        if (k == pxt.CONFIG_NAME)
            content = prepareConfigForGithub(content);
        if (content && treeEnt.sha != gitsha(content)) {
            isCurrent = false
            continue
        }
    }

    h.githubCurrent = isCurrent

    // this happens for older projects
    if (needsBlobs)
        await githubUpdateToAsync(h, {
            repo: gitjson.repo,
            sha: gitjson.commit.sha,
            files,
            justJSON: true
        })

    if (gitjson.isFork == null) {
        const p = pxt.github.parseRepoId(gitjson.repo)
        const r = await pxt.github.repoAsync(p.fullName, null);
        if (r) {
            gitjson.isFork = !!r.fork
            files[GIT_JSON] = JSON.stringify(gitjson, null, 4)
            await saveAsync(h, files)
        }
    }
}

// replace all file|worspace references with github sha
// createRelease: determine if tags need to be enforced
export function prepareConfigForGithub(content: string, createRelease?: boolean): string {
    // replace workspace: references with resolve github sha/tags.
    const cfg = pxt.Package.parseAndValidConfig(content);
    if (!cfg) return content;

    // cleanup
    delete (<any>cfg).installedVersion // cleanup old pxt.json files
    delete cfg.additionalFilePath
    delete cfg.additionalFilePaths

    // add list of supported targets
    const supportedTargets = cfg.supportedTargets || [];
    if (supportedTargets.indexOf(pxt.appTarget.id) < 0) {
        supportedTargets.push(pxt.appTarget.id);
        supportedTargets.sort(); // keep list stable
        cfg.supportedTargets = supportedTargets;
    }

    // track target and target version this was last edited in, so we can apply upgrade rules on import.
    cfg.targetVersions = {
        ...cfg.targetVersions,
        target: pxt.appTarget.versions.target,
        targetId: pxt.appTarget.id
    }

    // patch dependencies
    const localDependencies = Object.keys(cfg.dependencies)
        .filter(d => /^(file|workspace):/.test(cfg.dependencies[d]));
    for (const d of localDependencies)
        resolveDependency(d);

    return pxt.Package.stringifyConfig(cfg);

    function resolveDependency(d: string) {
        const v = cfg.dependencies[d];
        const hid = v.substring(v.indexOf(':') + 1);
        const header = getHeader(hid);
        if (!header) return; // missing workspace dependency, maybe deleted
        if (!header.githubId) {
            if (createRelease)
                U.userError(lf("Dependency {0} is a local project.", d))
        } else {
            const gid = pxt.github.parseRepoId(header.githubId);
            if (createRelease && !/^v\d+/.test(header.githubTag))
                U.userError(lf("You need to create a release for dependency {0}.", d))
            const tag = header.githubTag || gid.tag;
            cfg.dependencies[d] = `github:${gid.fullName}#${tag}`;
        }
    }
}

export async function initializeGithubRepoAsync(hd: Header, repoid: string, forceTemplateFiles: boolean, binaryJs: boolean) {
    await cloudsync.ensureGitHubTokenAsync();

    let parsed = pxt.github.parseRepoId(repoid)
    let name = parsed.fullName.replace(/.*\//, "")

    let currFiles = await getTextAsync(hd.id);

    const templateFiles = pxt.template.packageFiles(name);
    pxt.template.packageFilesFixup(templateFiles, {
        repo: parsed.fullName,
        repoowner: parsed.owner,
        reponame: parsed.project,
        repotag: parsed.tag
    });

    if (forceTemplateFiles) {
        U.jsonMergeFrom(currFiles, templateFiles);
    } else {
        // special handling of broken/missing/corrupted pxt.json
        if (!pxt.Package.parseAndValidConfig(currFiles[pxt.CONFIG_NAME]))
            delete currFiles[pxt.CONFIG_NAME];
        // special case append README.md content: append to existing file
        let templateREADME = templateFiles[pxt.README_FILE];
        const currREADME = currFiles[pxt.README_FILE];
        if (templateREADME || currREADME)
            templateREADME = [currREADME, templateREADME].filter(s => !!s).join(`

`);
        // current files override defaults
        U.jsonMergeFrom(templateFiles, currFiles);
        currFiles = templateFiles;
        if (templateREADME)
            currFiles[pxt.README_FILE] = templateREADME;
    }

    // update config with files if needed
    const pxtjson = pxt.Package.parseAndValidConfig(currFiles[pxt.CONFIG_NAME]);
    const files = pxtjson.files;
    // if no ts files, add existing ones
    if (!files.filter(f => /\.ts$/.test(f)).length) {
        // add files from the template
        Object.keys(currFiles)
            .filter(f => /\.(blocks|ts|py|asm|md|json)$/.test(f))
            .filter(f => f != pxt.CONFIG_NAME)
            .forEach(f => files.push(f));
    }
    // update test file if needed
    const testFiles = pxtjson.testFiles || (pxtjson.testFiles = []);
    if (currFiles["test.ts"] && testFiles.indexOf("test.ts") < 0) {
        testFiles.push("test.ts");
    }
    // save updated pxtjson
    currFiles[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(pxtjson);

    // save
    await forceSaveAsync(hd, currFiles)
    await commitAsync(hd, {
        message: lf("Initial files for MakeCode project"),
        filenamesToCommit: Object.keys(currFiles),
        binaryJs
    })

    // remove files not in the package (only in git)
    currFiles = await getTextAsync(hd.id)
    const allfiles = pxt.allPkgFiles(pxt.Package.parseAndValidConfig(currFiles[pxt.CONFIG_NAME]))
    const ignoredFiles = [GIT_JSON, pxt.SIMSTATE_JSON, pxt.SERIAL_EDITOR_FILE, pxt.CONFIG_NAME];
    Object.keys(currFiles)
        .filter(f => ignoredFiles.indexOf(f) < 0 && allfiles.indexOf(f) < 0)
        .forEach(f => delete currFiles[f]);

    await saveAsync(hd, currFiles)

    // try enable github pages
    try {
        await pxt.github.enablePagesAsync(parsed.slug);
    } catch (e) {
        pxt.reportException(e);
    }

    return hd
}

export async function importGithubAsync(id: string): Promise<Header> {
    const repoid = pxt.github.normalizeRepoId(id).replace(/^github:/, "")
    const parsed = pxt.github.parseRepoId(repoid)

    let sha = ""
    let isEmpty = false
    let forceTemplateFiles = false;
    try {
        sha = await pxt.github.getRefAsync(parsed.slug, parsed.tag)
        // if the repo does not have a pxt.json file, treat as empty
        // (must be done before)
        const commit = await pxt.github.getCommitAsync(parsed.slug, sha)
        const pxtConfigPath = pxt.github.join(parsed.fileName, pxt.CONFIG_NAME);
        if (!commit.tree.tree.find(f => f.path == pxtConfigPath)) {
            pxt.debug(`github: detected import non-makecode project`)
            if (pxt.shell.isReadOnly())
                U.userError(lf("This repository looks empty."));
            isEmpty = true; // needs initialization
            forceTemplateFiles = false;
            // ask user before modifying project
            const r = await core.confirmAsync({
                header: parsed.fileName ? lf("Add a nested extension to existing GitHub repository?") : lf("Initialize GitHub repository for MakeCode?"),
                body: parsed.fileName ? lf("We need to add a few files under the /{0} folder to your GitHub repository https://github.com/{1} to create the nested extension.", parsed.fileName, parsed.slug)
                    : lf("We need to add a few files to your GitHub repository https://github.com/{0} to make it work with MakeCode.", parsed.fullName),
                agreeLbl: lf("Ok"),
                hasCloseIcon: true,
                helpUrl: "/github/import"
            })
            if (!r) return Promise.resolve(undefined);
        }
    } catch (e) {
        if (e.statusCode == 409) {
            // this means repo is completely empty;
            // put all default files in there
            pxt.debug(`github: detected import empty project`)
            if (pxt.shell.isReadOnly())
                U.userError(lf("This repository looks empty."));
            await cloudsync.ensureGitHubTokenAsync();
            await pxt.github.putFileAsync(parsed.fullName, ".gitignore", "# Initial\n");
            isEmpty = true;
            forceTemplateFiles = true;
            sha = await pxt.github.getRefAsync(parsed.slug, parsed.tag)
        }
        else if (e.statusCode == 404) {
            core.errorNotification(lf("Sorry, that repository looks invalid."));
            U.userError(lf("No such repository or branch."));
        }
    }

    const hd = await githubUpdateToAsync(null, {
        repo: repoid,
        sha,
        files: {}
    })
    if (hd && isEmpty)
        await initializeGithubRepoAsync(hd, repoid, forceTemplateFiles, false);
    return hd
}

export function downloadFilesByIdAsync(id: string): Promise<pxt.Map<string>> {
    return Cloud.privateGetAsync(id, /* forceLiveEndpoint */ true)
        .then((scr: Cloud.JsonScript) => getPublishedScriptAsync(scr.id));
}

export function installByIdAsync(id: string) {
    return Cloud.privateGetAsync(id, /* forceLiveEndpoint */ true)
        .then((scr: Cloud.JsonScript) =>
            getPublishedScriptAsync(scr.id)
                .then(files => installAsync(
                    {
                        name: scr.name,
                        pubId: id,
                        pubCurrent: true,
                        meta: scr.meta,
                        editor: scr.editor,
                        target: scr.target,
                        targetVersion: scr.targetVersion || (scr.meta && scr.meta.versions && scr.meta.versions.target)
                    }, files)))
}

// this promise is set while a sync is in progress
// cleared when sync is done.
let syncAsyncPromise: Promise<pxt.editor.EditorSyncState>;
export function syncAsync(): Promise<pxt.editor.EditorSyncState> {
    pxt.debug("workspace: sync")
    if (syncAsyncPromise) return syncAsyncPromise;
    return syncAsyncPromise = impl.listAsync()
        .catch((e) => {
            // There might be a problem with the native databases. Switch to memory for this session so the user can at
            // least use the editor.
            return switchToMemoryWorkspace("sync failed")
                .then(() => impl.listAsync());
        })
        .then(headers => {
            const existing = U.toDictionary(allScripts || [], h => h.header.id)
            // this is an in-place update the header instances
            allScripts = headers.map(hd => {
                let ex = existing[hd.id]
                if (ex) {
                    if (JSON.stringify(ex.header) !== JSON.stringify(hd)) {
                        U.jsonCopyFrom(ex.header, hd)
                        // force reload
                        ex.text = undefined
                        ex.version = undefined
                        data.invalidateHeader("header", hd);
                        data.invalidateHeader("text", hd);
                        data.invalidateHeader("pkg-git-status", hd);
                        pxt.data.invalidate("gh-commits:*"); // invalidate commits just in case
                    }
                } else {
                    ex = {
                        header: hd,
                        text: undefined,
                        version: undefined,
                    }
                }
                return ex;
            })
            Promise.all([cloudsync.syncAsync(), cloud.syncAsync()]); // sync in background
        })
        .then(() => {
            refreshHeadersSession();
            return impl.getSyncState ? impl.getSyncState() : null
        })
        .finally(() => {
            syncAsyncPromise = undefined;
        });
}

export function resetAsync() {
    allScripts = []
    return impl.resetAsync()
        .then(cloudsync.resetAsync)
        .then(db.destroyAsync)
        .then(pxt.BrowserUtils.clearTranslationDbAsync)
        .then(pxt.BrowserUtils.clearTutorialInfoDbAsync)
        .then(compiler.clearApiInfoDbAsync)
        .then(() => {
            pxt.storage.clearLocal();
            pxt.data.clearCache();
            // keep local token (localhost and electron) on reset
            if (Cloud.localToken)
                pxt.storage.setLocal("local_token", Cloud.localToken);
        })
        .then(() => syncAsync()) // sync again to notify other tabs
        .then(() => { });
}

export function loadedAsync() {
    if (impl.loadedAsync)
        return impl.loadedAsync()
    return Promise.resolve()
}

export function saveAssetAsync(id: string, filename: string, data: Uint8Array): Promise<void> {
    if (impl.saveAssetAsync)
        return impl.saveAssetAsync(id, filename, data)
    else
        return Promise.reject(new Error(lf("Assets not supported here.")))
}

export function listAssetsAsync(id: string): Promise<pxt.workspace.Asset[]> {
    if (impl.listAssetsAsync)
        return impl.listAssetsAsync(id)
    return Promise.resolve([])
}

export function isBrowserWorkspace() {
    return impl === browserworkspace.provider;
}

export function fireEvent(ev: pxt.editor.events.Event) {
    if (impl.fireEvent)
        return impl.fireEvent(ev)
    // otherwise, NOP
}

// debug helpers
const _abrvStrs: {[key: string]: string} = {};
let _abrvNextInt = 1;
function dbgShorten(s: string): string {
    if (!s)
        return "#0";
    if (!_abrvStrs[s]) {
        _abrvStrs[s] = "#" + _abrvNextInt;
        _abrvNextInt += 1;
    }
    return _abrvStrs[s]
}
export function dbgHdrToString(h: Header): string {
    if (!h) return "#null"
    return `${h.name} ${h.id.substr(0, 4)}..v${dbgShorten(h.cloudVersion)}@${h.modificationTime % 100}-${U.timeSince(h.modificationTime)}`;
}

/*
    header:<guid>   - one header
    header:*        - all headers
*/

pxt.data.mountVirtualApi("header", {
    getSync: p => {
        p = pxt.data.stripProtocol(p)
        if (p == "*") return getHeaders()
        return getHeader(p)
    },
})

/*
    headers:SEARCH   - search headers
*/

pxt.data.mountVirtualApi("headers", {
    getAsync: p => {
        p = pxt.data.stripProtocol(p)
        const headers = getHeaders()
        if (!p) return Promise.resolve(headers)
        return compiler.projectSearchAsync({ term: p, headers })
            .then((searchResults: pxtc.service.ProjectSearchInfo[]) => searchResults)
            .then(searchResults => {
                let searchResultsMap = U.toDictionary(searchResults || [], h => h.id)
                return headers.filter(h => searchResultsMap[h.id]);
            });
    },
    expirationTime: p => 5 * 1000,
    onInvalidated: () => {
        compiler.projectSearchClear();
    }
})

/*
    text:<guid>            - all files
    text:<guid>/<filename> - one file
*/
pxt.data.mountVirtualApi("text", {
    getAsync: p => {
        const m = /^[\w\-]+:([^\/]+)(\/(.*))?/.exec(p)
        return getTextAsync(m[1])
            .then(files => {
                if (m[3])
                    return files[m[3]]
                else return files;
            })
    },
})
