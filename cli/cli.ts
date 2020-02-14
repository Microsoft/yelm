/* tslint:disable:forin cli only run in node */

/// <reference path="../built/pxtlib.d.ts"/>
/// <reference path="../built/pxtcompiler.d.ts"/>
/// <reference path="../built/pxtpy.d.ts"/>
/// <reference path="../built/pxtsim.d.ts"/>

(global as any).pxt = pxt;

import * as nodeutil from './nodeutil';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';

import U = pxt.Util;
import Cloud = pxt.Cloud;
import Map = pxt.Map;

import * as server from './server';
import * as build from './buildengine';
import * as commandParser from './commandparser';
import * as hid from './hid';
import * as gdb from './gdb';
import * as clidbg from './clidbg';
import * as pyconv from './pyconv';
import * as gitfs from './gitfs';
import * as crowdin from './crowdin';

const rimraf: (f: string, opts: any, cb: (err: any, res: any) => void) => void = require('rimraf');

let forceCloudBuild = process.env["KS_FORCE_CLOUD"] !== "no";
let forceLocalBuild = !!process.env["PXT_FORCE_LOCAL"];
let forceBuild = false; // don't use cache

Error.stackTraceLimit = 100;

function parseBuildInfo(parsed?: commandParser.ParsedCommand) {
    const cloud = parsed && parsed.flags["cloudbuild"];
    const local = parsed && parsed.flags["localbuild"];
    let hwvariant = parsed && parsed.flags["hwvariant"] as string;
    forceBuild = parsed && !!parsed.flags["force"];
    if (cloud && local)
        U.userError("cannot specify local-build and cloud-build together");

    if (cloud) {
        forceCloudBuild = true;
        forceLocalBuild = false;
    }
    if (local) {
        forceCloudBuild = false;
        forceLocalBuild = true;
    }

    if (hwvariant) {
        if (!/^hw---/.test(hwvariant)) hwvariant = 'hw---' + hwvariant;
        pxt.debug(`setting hardware variant to ${hwvariant}`);
        pxt.setHwVariant(hwvariant)
    }
}

const p = new commandParser.CommandParser();

function initTargetCommands() {
    let cmdsjs = path.join(nodeutil.targetDir, 'built/cmds.js');
    if (fs.existsSync(cmdsjs)) {
        pxt.debug(`loading cli extensions...`)
        let cli = require.main.require(cmdsjs)
        if (cli.deployAsync) {
            pxt.commands.deployFallbackAsync = cli.deployAsync
        }
        if (cli.addCommands) {
            cli.addCommands(p)
        }
    }
}

let prevExports = (global as any).savedModuleExports
if (prevExports) {
    module.exports = prevExports
}

export interface UserConfig {
    localToken?: string;
    noAutoBuild?: boolean;
    noAutoStart?: boolean;
    localBuild?: boolean;
    noSerial?: boolean;
}

interface TargetPackageInfo {
    options: pxtc.CompileOptions;
    api: pxtc.ApisInfo;
    sha: string;
}

let reportDiagnostic = reportDiagnosticSimply;
const targetJsPrefix = "var pxtTargetBundle = "

function reportDiagnostics(diagnostics: pxtc.KsDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
        reportDiagnostic(diagnostic);
    }
}

function reportDiagnosticSimply(diagnostic: pxtc.KsDiagnostic): void {
    let output = pxtc.getDiagnosticString(diagnostic)
    pxt.log(output);
}

function fatal(msg: string): Promise<any> {
    pxt.log("Fatal error: " + msg)
    throw new Error(msg)
}

export let globalConfig: UserConfig = {}

function homePxtDir() {
    return path.join(process.env["HOME"] || process.env["UserProfile"], ".pxt")
}

function cacheDir() {
    return path.join(homePxtDir(), "cache")
}

function configPath() {
    return path.join(homePxtDir(), "config.json")
}

let homeDirsMade = false
function mkHomeDirs() {
    if (homeDirsMade) return
    homeDirsMade = true
    if (!fs.existsSync(homePxtDir()))
        fs.mkdirSync(homePxtDir())
    if (!fs.existsSync(cacheDir()))
        fs.mkdirSync(cacheDir())
}

function saveConfig() {
    mkHomeDirs()
    nodeutil.writeFileSync(configPath(), JSON.stringify(globalConfig, null, 4) + "\n")
}

function initConfigAsync(): Promise<void> {
    let p = Promise.resolve();
    let atok: string = process.env["PXT_ACCESS_TOKEN"]
    if (fs.existsSync(configPath())) {
        let config = <UserConfig>readJson(configPath())
        globalConfig = config;
    }

    p.then(() => {
        if (atok) {
            let mm = /^(https?:.*)\?access_token=([\w\.]+)/.exec(atok)
            if (!mm) {
                console.error("Invalid accessToken format, expecting something like 'https://example.com/?access_token=0abcd.XXXX'")
                return
            }
            Cloud.apiRoot = mm[1].replace(/\/$/, "").replace(/\/api$/, "") + "/api/"
            Cloud.accessToken = mm[2]
        }
    });
    return p;
}


function loadGithubTokenAsync(): Promise<string> {
    pxt.github.token = process.env["GITHUB_ACCESS_TOKEN"] || process.env["GITHUB_TOKEN"];
    return Promise.resolve(pxt.github.token);
}

function searchAsync(...query: string[]) {
    return loadGithubTokenAsync()
        .then(() => pxt.packagesConfigAsync())
        .then(config => pxt.github.searchAsync(query.join(" "), config))
        .then(res => {
            for (let r of res) {
                console.log(`${r.fullName}: ${r.description}`)
            }
        })
}

function pkginfoAsync(repopath: string) {
    let parsed = pxt.github.parseRepoId(repopath)
    if (!parsed) {
        console.log('Unknown repo');
        return Promise.resolve();
    }

    const pkgInfo = (cfg: pxt.PackageConfig, tag?: string) => {
        pxt.log(`name: ${cfg.name}`)
        pxt.log(`description: ${cfg.description}`)
        if (pxt.appTarget.appTheme)
            pxt.log(`shareable url: ${pxt.appTarget.appTheme.embedUrl}#pub:gh/${parsed.fullName}${tag ? "#" + tag : ""}`)
    }

    return loadGithubTokenAsync()
        .then(() => pxt.packagesConfigAsync())
        .then(config => {
            const status = pxt.github.repoStatus(parsed, config);
            pxt.log(`github org: ${parsed.owner}`);
            if (parsed.tag) pxt.log(`github tag: ${parsed.tag}`);
            pxt.log(`package status: ${status == pxt.github.GitRepoStatus.Approved ? "approved" : status == pxt.github.GitRepoStatus.Banned ? "banned" : "neutral"}`)
            if (parsed.tag)
                return pxt.github.downloadPackageAsync(repopath, config)
                    .then(pkg => {
                        let cfg: pxt.PackageConfig = JSON.parse(pkg.files[pxt.CONFIG_NAME])
                        pkgInfo(cfg, parsed.tag)
                        pxt.debug(`size: ${JSON.stringify(pkg.files).length}`)
                    })

            return pxt.github.pkgConfigAsync(parsed.fullName)
                .then(cfg => {
                    pkgInfo(cfg)
                    return pxt.github.listRefsAsync(repopath)
                        .then(tags => {
                            pxt.log("tags: " + tags.join(", "))
                            return pxt.github.listRefsAsync(repopath, "heads")
                        })
                        .then(heads => {
                            pxt.log("branches: " + heads.join(", "))
                        })
                })
        })
}

export function pokeRepoAsync(parsed: commandParser.ParsedCommand): Promise<void> {
    const repo = parsed.args[0];

    let data = {
        repo: repo,
        getkey: false
    }
    if (parsed.flags["u"]) data.getkey = true
    return Cloud.privatePostAsync("pokerepo", data)
        .then(resp => {
            console.log(resp)
        })
}

export function apiAsync(path: string, postArguments?: string): Promise<void> {
    if (postArguments == "delete") {
        return Cloud.privateDeleteAsync(path)
            .then(resp => console.log(resp))
    }

    if (postArguments == "-") {
        return nodeutil.readResAsync(process.stdin)
            .then(buf => buf.toString("utf8"))
            .then(str => apiAsync(path, str))
    }

    if (postArguments && fs.existsSync(postArguments))
        postArguments = fs.readFileSync(postArguments, "utf8");

    let dat = postArguments ? JSON.parse(postArguments) : null
    if (dat)
        console.log("POST", "/api/" + path, JSON.stringify(dat, null, 2))

    return Cloud.privateRequestAsync({
        url: path,
        data: dat
    })
        .then(resp => {
            if (resp.json)
                console.log(JSON.stringify(resp.json, null, 2))
            else console.log(resp.text)
        })
}

function uploadFileAsync(parsed: commandParser.ParsedCommand) {
    const path = parsed.args[0];
    let buf = fs.readFileSync(path)
    let mime = U.getMime(path)
    console.log("Upload", path)
    return Cloud.privatePostAsync("upload/files", {
        filename: path,
        encoding: "base64",
        content: buf.toString("base64"),
        contentType: mime
    })
        .then(resp => {
            console.log(resp)
        })
}

let readlineCount = 0
function readlineAsync() {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    readlineCount++
    return new Promise<string>((resolve, reject) => {
        process.stdin.once('data', (text: string) => {
            resolve(text)
        })
    })
}

export function queryAsync(msg: string, defl: string) {
    process.stdout.write(`${msg} [${defl}]: `)
    return readlineAsync()
        .then(text => {
            text = text.trim()
            if (!text) return defl
            else return text
        })
}

export function yesNoAsync(msg: string): Promise<boolean> {
    process.stdout.write(msg + " (y/n): ")
    return readlineAsync()
        .then(text => {
            if (text.trim().toLowerCase() == "y")
                return Promise.resolve(true)
            else if (text.trim().toLowerCase() == "n")
                return Promise.resolve(false)
            else return yesNoAsync(msg)
        })
}

function onlyExts(files: string[], exts: string[]) {
    return files.filter(f => exts.indexOf(path.extname(f)) >= 0)
}

function pxtFileList(pref: string) {
    return nodeutil.allFiles(pref + "webapp/public")
        .concat(onlyExts(nodeutil.allFiles(pref + "built/web", 1), [".js", ".css"]))
        .concat(nodeutil.allFiles(pref + "built/web/fonts", 1))
        .concat(nodeutil.allFiles(pref + "built/web/vs", 4))

}

function semverCmp(a: string, b: string) {
    let parse = (s: string) => {
        let v = s.split(/\./).map(parseInt)
        return v[0] * 100000000 + v[1] * 10000 + v[2]
    }
    return parse(a) - parse(b)
}

let readJson = nodeutil.readJson;

function ciAsync() {
    forceCloudBuild = true;
    const buildInfo = ciBuildInfo();
    pxt.log(`ci build using ${buildInfo.ci}`);
    if (!buildInfo.tag)
        buildInfo.tag = "";
    if (!buildInfo.branch)
        buildInfo.branch = "local"

    const { tag, branch, pullRequest } = buildInfo
    const atok = process.env.NPM_ACCESS_TOKEN
    const npmPublish = /^v\d+\.\d+\.\d+$/.exec(tag) && atok;

    if (npmPublish) {
        let npmrc = path.join(process.env.HOME, ".npmrc")
        pxt.log(`setting up ${npmrc}`)
        let cfg = "//registry.npmjs.org/:_authToken=" + atok + "\n"
        fs.writeFileSync(npmrc, cfg)
    }

    const latest = branch == "master" ? "latest" : "git-" + branch
    // upload locs on build on master
    const masterOrReleaseBranchRx = /^(master|v\d+\.\d+\.\d+)$/;
    const apiStringBranchRx = pxt.appTarget.uploadApiStringsBranchRx
        ? new RegExp(pxt.appTarget.uploadApiStringsBranchRx)
        : masterOrReleaseBranchRx;
    const uploadDocs = !pullRequest
        && !!pxt.appTarget.uploadDocs
        && masterOrReleaseBranchRx.test(branch);
    const uploadApiStrings = !pullRequest
        && (!!pxt.appTarget.uploadDocs || pxt.appTarget.uploadApiStringsBranchRx)
        && apiStringBranchRx.test(branch);

    pxt.log(`tag: ${tag}`);
    pxt.log(`branch: ${branch}`);
    pxt.log(`latest: ${latest}`);
    pxt.log(`pull request: ${pullRequest}`);
    pxt.log(`upload api strings: ${uploadApiStrings}`);
    pxt.log(`upload docs: ${uploadDocs}`);

    function npmPublishAsync() {
        if (!npmPublish) return Promise.resolve();
        return nodeutil.runNpmAsync("publish");
    }

    let pkg = readJson("package.json")
    if (pkg["name"] == "pxt-core") {
        pxt.log("pxt-core build");
        let p = npmPublishAsync();
        if (uploadDocs)
            p = p
                .then(() => buildWebStringsAsync())
                .then(() => crowdin.execCrowdinAsync("upload", "built/webstrings.json"));
        if (uploadApiStrings)
            p = p.then(() => crowdin.execCrowdinAsync("upload", "built/strings.json"))
        if (uploadDocs || uploadApiStrings)
            p = p.then(() => crowdin.internalUploadTargetTranslationsAsync(uploadApiStrings, uploadDocs));
        return p;
    } else {
        pxt.log("target build");
        return internalBuildTargetAsync()
            .then(() => internalCheckDocsAsync(true))
            .then(() => blockTestsAsync())
            .then(() => npmPublishAsync())
            .then(() => {
                if (!process.env["PXT_ACCESS_TOKEN"]) {
                    // pull request, don't try to upload target
                    pxt.log('no token, skipping upload')
                    return Promise.resolve();
                }
                const trg = readLocalPxTarget();
                const label = `${trg.id}/${tag || latest}`;
                pxt.log(`uploading target with label ${label}...`);
                return uploadTargetAsync(label);
            })
            .then(() => {
                pxt.log("target uploaded");
                if (uploadDocs || uploadApiStrings) {
                    return crowdin.internalUploadTargetTranslationsAsync(uploadApiStrings, uploadDocs)
                        .then(() => pxt.log("translations uploaded"));
                } else {
                    pxt.log("skipping translations upload");
                    return Promise.resolve();
                }
            });
    }
}

function bumpPxtCoreDepAsync(): Promise<void> {
    let pkg = readJson("package.json")
    if (pkg["name"] == "pxt-core") return Promise.resolve(pkg)

    let gitPull = Promise.resolve();
    let commitMsg: string = "";

    ["pxt-core", "pxt-common-packages"].forEach(knownPackage => {
        const modulePath = path.join("node_modules", knownPackage)
        if (fs.existsSync(path.join(modulePath, ".git"))) {
            gitPull = gitPull.then(() => nodeutil.spawnAsync({
                cmd: "git",
                args: ["pull"],
                cwd: modulePath
            }))
        }

        // not referenced
        if (!fs.existsSync(path.join(modulePath, "package.json")))
            return;

        gitPull
            .then(() => {
                let kspkg = readJson(path.join(modulePath, "package.json"));
                let currVer = pkg["dependencies"][knownPackage]
                if (!currVer) return; // not referenced
                let newVer = kspkg["version"]
                if (currVer == newVer) {
                    console.log(`Referenced ${knownPackage} dep up to date: ${currVer}`)
                    return;
                }

                console.log(`Bumping ${knownPackage} dep version: ${currVer} -> ${newVer}`)
                if (currVer != "*" && pxt.semver.strcmp(currVer, newVer) > 0) {
                    U.userError(`Trying to downgrade ${knownPackage}.`)
                }
                if (currVer != "*" && pxt.semver.majorCmp(currVer, newVer) < 0) {
                    U.userError(`Trying to automatically update major version, please edit package.json manually.`)
                }
                pkg["dependencies"][knownPackage] = newVer
                nodeutil.writeFileSync("package.json", nodeutil.stringify(pkg) + "\n")
                commitMsg += `${commitMsg ? ", " : ""}bump ${knownPackage} to ${newVer}`;
            })
    })

    gitPull = gitPull
        .then(() => commitMsg ? nodeutil.runGitAsync("commit", "-m", commitMsg, "--", "package.json") : Promise.resolve());

    return gitPull;
}

function updateAsync() {
    return Promise.resolve()
        .then(() => nodeutil.runGitAsync("pull"))
        .then(() => bumpPxtCoreDepAsync())
        .then(() => nodeutil.runNpmAsync("install"));
}

function justBumpPkgAsync() {
    ensurePkgDir()
    return nodeutil.needsGitCleanAsync()
        .then(() => mainPkg.loadAsync())
        .then(() => {
            let v = pxt.semver.parse(mainPkg.config.version)
            v.patch++
            return queryAsync("New version", pxt.semver.stringify(v))
        })
        .then(nv => {
            let v = pxt.semver.parse(nv)
            mainPkg.config.version = pxt.semver.stringify(v)
            mainPkg.saveConfig()
        })
        .then(() => nodeutil.runGitAsync("commit", "-a", "-m", mainPkg.config.version))
        .then(() => nodeutil.runGitAsync("tag", "v" + mainPkg.config.version))
}

function tagReleaseAsync(parsed: commandParser.ParsedCommand) {
    const tag = parsed.args[0] as string;
    const version = parsed.args[1] as string;
    const npm = !!parsed.flags["npm"];

    // check that ...-ref.json exists for that tag
    const fn = path.join('docs', tag + "-ref.json");
    pxt.log(`checking ${fn}`)
    if (!fn)
        U.userError(`file ${fn} does not exist`);
    const v = pxt.semver.normalize(version);
    const npmPkg = `pxt-${pxt.appTarget.id}`;
    if (!pxt.appTarget.appTheme.githubUrl)
        U.userError('pxtarget theme missing "githubUrl" entry');
    // check that tag exists in github
    pxt.log(`checking github ${pxt.appTarget.appTheme.githubUrl} tag v${v}`);
    return U.requestAsync({
        url: pxt.appTarget.appTheme.githubUrl.replace(/\/$/, '') + "/releases/tag/v" + v,
        method: "GET"
    })
        // check that release exists in npm
        .then(() => {
            if (!npm) return Promise.resolve();
            pxt.log(`checking npm ${npmPkg} release`)
            return nodeutil.npmRegistryAsync(npmPkg)
                .then(registry => {
                    // verify that npm version exists
                    if (!registry.versions[v])
                        U.userError(`cannot find npm package ${npmPkg}@${v}`);
                    const npmTag = tag == "index" ? "latest" : tag;
                    return nodeutil.runNpmAsync(`dist-tag`, `add`, `${npmPkg}@v${v}`, npmTag);
                })
        })
        // all good update ref file
        .then(() => {
            // update index file
            nodeutil.writeFileSync(fn, JSON.stringify({
                "appref": "v" + v
            }, null, 4))
            // TODO commit changes
            console.log(`please commit ${fn} changes`);
        })
}

function bumpAsync(parsed?: commandParser.ParsedCommand) {
    const bumpPxt = parsed && parsed.flags["update"];
    const upload = parsed && parsed.flags["upload"];
    if (fs.existsSync(pxt.CONFIG_NAME)) {
        if (upload) throw U.userError("upload only supported on targets");

        return Promise.resolve()
            .then(() => nodeutil.runGitAsync("pull"))
            .then(() => justBumpPkgAsync())
            .then(() => nodeutil.runGitAsync("push", "--tags"))
            .then(() => nodeutil.runGitAsync("push"))
    }
    else if (fs.existsSync("pxtarget.json"))
        return Promise.resolve()
            .then(() => nodeutil.runGitAsync("pull"))
            .then(() => bumpPxt ? bumpPxtCoreDepAsync().then(() => nodeutil.runGitAsync("push")) : Promise.resolve())
            .then(() => nodeutil.runNpmAsync("version", "patch"))
            .then(() => nodeutil.runGitAsync("push", "--tags"))
            .then(() => nodeutil.runGitAsync("push"))
            .then(() => upload ? uploadTaggedTargetAsync() : Promise.resolve())
    else {
        throw U.userError("Couldn't find package or target JSON file; nothing to bump")
    }
}

function uploadTaggedTargetAsync() {
    forceCloudBuild = true
    return loadGithubTokenAsync()
        .then(token => {
            if (!token) {
                fatal("GitHub token not found, please use 'pxt login' to login with your GitHub account to push releases.");
                return Promise.resolve();
            }
            return nodeutil.needsGitCleanAsync()
                .then(() => Promise.all([
                    nodeutil.currGitTagAsync(),
                    nodeutil.gitInfoAsync(["rev-parse", "--abbrev-ref", "HEAD"]),
                    nodeutil.gitInfoAsync(["rev-parse", "HEAD"])
                ]))
                // only build target after getting all the info
                .then(info =>
                    internalBuildTargetAsync()
                        .then(() => internalCheckDocsAsync(true))
                        .then(() => info))
                .then(info => {
                    const repoSlug = "microsoft/pxt-" + pxt.appTarget.id
                    setCiBuildInfo(info[0], info[1], info[2], repoSlug)
                    process.env['PXT_RELEASE_REPO'] = "https://git:" + token + "@github.com/" + repoSlug + "-built"
                    let v = pkgVersion()
                    pxt.log("uploading " + v)
                    return uploadCoreAsync({
                        label: "v" + v,
                        fileList: pxtFileList("node_modules/pxt-core/").concat(targetFileList()),
                        pkgversion: v,
                        githubOnly: true,
                        fileContent: {}
                    })
                })
        });
}

function pkgVersion() {
    let ver = readJson("package.json")["version"]
    const info = ciBuildInfo()
    if (!info.tag)
        ver += "-" + (info.commit ? info.commit.slice(0, 6) : "local")
    return ver
}

function targetFileList() {
    let lst = onlyExts(nodeutil.allFiles("built"), [".js", ".css", ".json", ".webmanifest"])
        .concat(nodeutil.allFiles(path.join(simDir(), "public")));
    if (simDir() != "sim")
        lst = lst.concat(nodeutil.allFiles(path.join("sim", "public"), 5, true))
    pxt.debug(`target files (on disk): ${lst.join('\r\n    ')}`)
    return lst;
}

function uploadTargetAsync(label: string) {
    return uploadCoreAsync({
        label,
        fileList: pxtFileList("node_modules/pxt-core/").concat(targetFileList()),
        pkgversion: pkgVersion(),
        fileContent: {}
    })
}

export function uploadTargetReleaseAsync(parsed?: commandParser.ParsedCommand) {
    parseBuildInfo(parsed);
    const label = parsed.args[0];
    const rebundle = !!parsed.flags["rebundle"];
    return (rebundle ? rebundleAsync() : internalBuildTargetAsync())
        .then(() => {
            return uploadTargetAsync(label);
        });
}

export function uploadTargetRefsAsync(repoPath: string) {
    if (repoPath) process.chdir(repoPath);
    return nodeutil.needsGitCleanAsync()
        .then(() => Promise.all([
            nodeutil.gitInfoAsync(["rev-parse", "HEAD"]),
            nodeutil.gitInfoAsync(["config", "--get", "remote.origin.url"])
        ]))
        .then(info => {
            return gitfs.uploadRefs(info[0], info[1])
                .then(() => {
                    return Promise.resolve();
                });
        })
}

interface UploadOptions {
    fileList: string[];
    pkgversion: string;
    fileContent?: Map<string>;
    label?: string
    legacyLabel?: boolean;
    target?: string;
    localDir?: string;
    githubOnly?: boolean;
    builtPackaged?: string;
    minify?: boolean;
    noAppCache?: boolean;
}

interface BlobReq {
    hash: string;
    content: string;
    encoding: string;
    filename: string; // comment only
    size: number; // ditto
}

type GitTree = Map<GitEntry>;
interface GitEntry {
    hash?: string;
    subtree?: GitTree;
}

interface CommitInfo {
    tree: GitTree;
    parents: string[];
    message: string;
    target: string;
}

function uploadFileName(p: string) {
    // normalize /, \ before filtering
    return p.replace(/\\/g, '\/')
        .replace(/^.*(built\/web\/|\w+\/public\/|built\/)/, "")
}

function gitUploadAsync(opts: UploadOptions, uplReqs: Map<BlobReq>) {
    let reqs = U.unique(U.values(uplReqs), r => r.hash)
    console.log("Asking for", reqs.length, "hashes")
    return Promise.resolve()
        .then(() => Cloud.privatePostAsync("upload/status", {
            hashes: reqs.map(r => r.hash)
        }))
        .then(resp => {
            let missing = U.toDictionary(resp.missing as string[], s => s)
            let missingReqs = reqs.filter(r => !!U.lookup(missing, r.hash))
            let size = 0
            for (let r of missingReqs) size += r.size
            console.log("files missing: ", missingReqs.length, size, "bytes")
            return Promise.map(missingReqs,
                r => Cloud.privatePostAsync("upload/blob", r)
                    .then(() => {
                        console.log(r.filename + ": OK," + r.size + " " + r.hash)
                    }))
        })
        .then(() => {
            let roottree: Map<GitEntry> = {}
            let get = (tree: GitTree, path: string): GitEntry => {
                let subt = U.lookup(tree, path)
                if (!subt)
                    subt = tree[path] = {}
                return subt
            }
            let lookup = (tree: GitTree, path: string): GitEntry => {
                let m = /^([^\/]+)\/(.*)/.exec(path)
                if (m) {
                    let subt = get(tree, m[1])
                    U.assert(!subt.hash)
                    if (!subt.subtree) subt.subtree = {}
                    return lookup(subt.subtree, m[2])
                } else {
                    return get(tree, path)
                }
            }
            for (let fn of Object.keys(uplReqs)) {
                let e = lookup(roottree, fn)
                e.hash = uplReqs[fn].hash
            }
            const info = ciBuildInfo()
            let data: CommitInfo = {
                message: "Upload from " + info.commitUrl,
                parents: [],
                target: pxt.appTarget.id,
                tree: roottree,
            }
            console.log("Creating commit...")
            return Cloud.privatePostAsync("upload/commit", data)
        })
        .then(res => {
            console.log("Commit:", res)
            return uploadToGitRepoAsync(opts, uplReqs)
        })
}

function uploadToGitRepoAsync(opts: UploadOptions, uplReqs: Map<BlobReq>) {
    let label = opts.label
    if (!label) {
        console.log('no label; skip release upload');
        return Promise.resolve();
    }
    let tid = pxt.appTarget.id
    if (U.startsWith(label, tid + "/"))
        label = label.slice(tid.length + 1)
    if (!/^v\d/.test(label)) {
        console.log('label is not a version; skipping release upload');
        return Promise.resolve();
    }
    let repoUrl = process.env["PXT_RELEASE_REPO"]
    if (!repoUrl) {
        console.log("no $PXT_RELEASE_REPO variable; not uploading label " + label)
        return Promise.resolve()
    }
    nodeutil.mkdirP("tmp")
    let trgPath = "tmp/releases"
    let mm = /^https:\/\/([^:]+):([^@]+)@([^\/]+)(.*)/.exec(repoUrl)
    if (!mm) {
        U.userError("wrong format for $PXT_RELEASE_REPO")
    }

    console.log(`create release ${label} in ${repoUrl}`);

    let user = mm[1]
    let pass = mm[2]
    let host = mm[3]
    let netRcLine = `machine ${host} login ${user} password ${pass}\n`
    repoUrl = `https://${user}@${host}${mm[4]}`

    let homePath = process.env["HOME"] || process.env["UserProfile"]
    let netRcPath = path.join(homePath, /^win/.test(process.platform) ? "_netrc" : ".netrc")
    let prevNetRc = fs.existsSync(netRcPath) ? fs.readFileSync(netRcPath, "utf8") : null
    let newNetRc = prevNetRc ? prevNetRc + "\n" + netRcLine : netRcLine
    console.log("Adding credentials to " + netRcPath)
    fs.writeFileSync(netRcPath, newNetRc, {
        encoding: "utf8",
        mode: '600'
    })

    let cuser = process.env["USER"] || ""
    if (cuser && !/travis/.test(cuser))
        user += "-" + cuser

    const cred = [
        "-c", "credential.helper=",
        "-c", "user.name=" + user,
        "-c", "user.email=" + user + "@build.pxt.io",
    ]
    const gitAsync = (args: string[]) => nodeutil.spawnAsync({
        cmd: "git",
        cwd: trgPath,
        args: cred.concat(args)
    })
    const info = ciBuildInfo()
    return Promise.resolve()
        .then(() => {
            if (fs.existsSync(trgPath)) {
                let cfg = fs.readFileSync(trgPath + "/.git/config", "utf8")
                if (cfg.indexOf("url = " + repoUrl) > 0) {
                    return gitAsync(["pull", "--depth=3"])
                } else {
                    throw U.userError(trgPath + " already exists; please remove it")
                }
            } else {
                return nodeutil.spawnAsync({
                    cmd: "git",
                    args: cred.concat(["clone", "--depth", "3", repoUrl, trgPath]),
                    cwd: "."
                })
            }
        })
        .then(() => {
            for (let u of U.values(uplReqs)) {
                let fpath = path.join(trgPath, u.filename)
                nodeutil.mkdirP(path.dirname(fpath))
                fs.writeFileSync(fpath, u.content, { encoding: u.encoding })
            }
            // make sure there's always something to commit
            fs.writeFileSync(trgPath + "/stamp.txt", new Date().toString())
        })
        .then(() => gitAsync(["add", "."]))
        .then(() => gitAsync(["commit", "-m", "Release " + label + " from " + info.commitUrl]))
        .then(() => gitAsync(["tag", label]))
        .then(() => gitAsync(["push"]))
        .then(() => gitAsync(["push", "--tags"]))
        .then(() => {
        })
        .finally(() => {
            if (prevNetRc == null) {
                console.log("Removing " + netRcPath)
                fs.unlinkSync(netRcPath)
            } else {
                console.log("Restoring " + netRcPath)
                fs.writeFileSync(netRcPath, prevNetRc, {
                    mode: '600'
                })
            }
        })
}

function uploadArtFile(fn: string): string {
    if (!fn || /^(https?|data):/.test(fn)) return fn; // nothing to do

    fn = fn.replace(/^\.?\/*/, "/")
    return "@cdnUrl@/blob/" + gitHash(fs.readFileSync("docs" + fn)) + "" + fn;
}

function gitHash(buf: Buffer) {
    let hash = crypto.createHash("sha1")
    hash.update(Buffer.from("blob " + buf.length + "\u0000", "utf8"))
    hash.update(buf)
    return hash.digest("hex")
}

function uploadCoreAsync(opts: UploadOptions) {
    let targetConfig = readLocalPxTarget();
    let defaultLocale = targetConfig.appTheme.defaultLocale;
    let hexCache = path.join("built", "hexcache");
    let hexFiles: string[] = [];

    if (fs.existsSync(hexCache)) {
        hexFiles = fs.readdirSync(hexCache)
            .filter(f => /\.hex$/.test(f))
            .filter(f => fs.readFileSync(path.join(hexCache, f), { encoding: "utf8" }) != "SKIP")
            .map((f) => `@cdnUrl@/compile/${f}`);
        pxt.log(`hex cache:\n\t${hexFiles.join('\n\t')}`)
    }

    let logos = (targetConfig.appTheme as any as Map<string>);
    let targetImages = Object.keys(logos)
        .filter(k => /(logo|hero)$/i.test(k) && /^\.\//.test(logos[k]));
    let targetImagesHashed = pxt.Util.unique(targetImages.map(k => uploadArtFile(logos[k])), url => url);

    let targetEditorJs = "";
    if (pxt.appTarget.appTheme && pxt.appTarget.appTheme.extendEditor)
        targetEditorJs = "@commitCdnUrl@editor.js";
    let targetFieldEditorsJs = "";
    if (pxt.appTarget.appTheme && pxt.appTarget.appTheme.extendFieldEditors)
        targetFieldEditorsJs = "@commitCdnUrl@fieldeditors.js";

    let replacements: Map<string> = {
        "/sim/simulator.html": "@simUrl@",
        "/sim/siminstructions.html": "@partsUrl@",
        "/sim/sim.webmanifest": "@relprefix@webmanifest",
        "/embed.js": "@targetUrl@@relprefix@embed",
        "/cdn/": "@commitCdnUrl@",
        "/doccdn/": "@commitCdnUrl@",
        "/sim/": "@commitCdnUrl@",
        "/blb/": "@blobCdnUrl@",
        "@timestamp@": "",
        "data-manifest=\"\"": "@manifest@",
        "var pxtConfig = null": "var pxtConfig = @cfg@",
        "@defaultLocaleStrings@": defaultLocale ? "@commitCdnUrl@" + "locales/" + defaultLocale + "/strings.json" : "",
        "@cachedHexFiles@": hexFiles.length ? hexFiles.join("\n") : "",
        "@targetEditorJs@": targetEditorJs,
        "@targetFieldEditorsJs@": targetFieldEditorsJs,
        "@targetImages@": targetImagesHashed.length ? targetImagesHashed.join('\n') : ''
    }

    if (opts.localDir) {
        let cfg: pxt.WebConfig = {
            "relprefix": opts.localDir,
            "verprefix": "",
            "workerjs": opts.localDir + "worker.js",
            "monacoworkerjs": opts.localDir + "monacoworker.js",
            "gifworkerjs": opts.localDir + "gifjs/gif.worker.js",
            "pxtVersion": pxtVersion(),
            "pxtRelId": "",
            "pxtCdnUrl": opts.localDir,
            "commitCdnUrl": opts.localDir,
            "blobCdnUrl": opts.localDir,
            "cdnUrl": opts.localDir,
            "targetVersion": opts.pkgversion,
            "targetRelId": "",
            "targetUrl": "",
            "targetId": opts.target,
            "simUrl": opts.localDir + "simulator.html",
            "partsUrl": opts.localDir + "siminstructions.html",
            "runUrl": opts.localDir + "run.html",
            "docsUrl": opts.localDir + "docs.html",
            "isStatic": true,
        }
        replacements = {
            "/embed.js": opts.localDir + "embed.js",
            "/cdn/": opts.localDir,
            "/doccdn/": opts.localDir,
            "/sim/": opts.localDir,
            "/blb/": opts.localDir,
            "@monacoworkerjs@": `${opts.localDir}monacoworker.js`,
            "@gifworkerjs@": `${opts.localDir}gifjs/gif.worker.js`,
            "@workerjs@": `${opts.localDir}worker.js`,
            "@timestamp@": `# ver ${new Date().toString()}`,
            "var pxtConfig = null": "var pxtConfig = " + JSON.stringify(cfg, null, 4),
            "@defaultLocaleStrings@": "",
            "@cachedHexFiles@": "",
            "@targetEditorJs@": targetEditorJs ? `${opts.localDir}editor.js` : "",
            "@targetFieldEditorsJs@": targetFieldEditorsJs ? `${opts.localDir}fieldeditors.js` : "",
            "@targetImages@": targetImages.length ? targetImages.map(k =>
                `${opts.localDir}${path.join('./docs', logos[k])}`).join('\n') : ''
        }
        if (!opts.noAppCache) {
            replacements["data-manifest=\"\""] = `manifest="${opts.localDir}release.manifest"`;
        }
    }

    let replFiles = [
        "index.html",
        "embed.js",
        "run.html",
        "docs.html",
        "siminstructions.html",
        "codeembed.html",
        "release.manifest",
        "worker.js",
        "monacoworker.js",
        "simulator.html",
        "sim.manifest",
        "sim.webmanifest",
    ]

    nodeutil.mkdirP("built/uploadrepl")

    let uplReqs: Map<BlobReq> = {}

    let uploadFileAsync = (p: string) => {
        let rdf: Promise<Buffer> = null
        if (opts.fileContent) {
            let s = U.lookup(opts.fileContent, p)
            if (s != null)
                rdf = Promise.resolve(Buffer.from(s, "utf8"))
        }
        if (!rdf) {
            if (!fs.existsSync(p))
                return undefined;
            rdf = readFileAsync(p)
        }

        const uglify = opts.minify ? require("uglify-js") : undefined;

        let fileName = uploadFileName(p)
        let mime = U.getMime(p)
        const minified = opts.minify && mime == "application/javascript" && fileName !== "target.js";

        pxt.log(`    ${p} -> ${fileName} (${mime})` + (minified ? ' minified' : ""));

        let isText = /^(text\/.*|application\/.*(javascript|json))$/.test(mime)
        let content = ""
        let data: Buffer;
        return rdf.then((rdata: Buffer) => {
            data = rdata;
            if (isText) {
                content = data.toString("utf8")
                if (fileName == "index.html") {
                    if (!opts.localDir) {
                        let m = pxt.appTarget.appTheme as Map<string>
                        for (let k of Object.keys(m)) {
                            if (/CDN$/.test(k))
                                m[k.slice(0, k.length - 3)] = m[k]
                        }
                    }
                    content = server.expandHtml(content)
                }

                if (/^sim/.test(fileName)) {
                    // just force blobs for everything in simulator manifest
                    content = content.replace(/\/(cdn|sim)\//g, "/blb/")
                }

                if (minified) {
                    const res = uglify.minify(content);
                    if (!res.error) {
                        content = res.code;
                    }
                    else {
                        pxt.log(`        Could not minify ${fileName} ${res.error}`)
                    }
                }

                if (replFiles.indexOf(fileName) >= 0) {
                    for (let from of Object.keys(replacements)) {
                        content = U.replaceAll(content, from, replacements[from])
                    }
                    if (opts.localDir) {
                        data = Buffer.from(content, "utf8")
                    } else {
                        // save it for developer inspection
                        fs.writeFileSync("built/uploadrepl/" + fileName, content)
                    }
                } else if (fileName == "target.json" || fileName == "target.js") {
                    let isJs = fileName == "target.js"
                    if (isJs) content = content.slice(targetJsPrefix.length)
                    let trg: pxt.TargetBundle = JSON.parse(content)
                    if (opts.localDir) {
                        for (let e of trg.appTheme.docMenu)
                            if (e.path[0] == "/") {
                                e.path = opts.localDir + "docs" + e.path;
                            }
                        trg.appTheme.homeUrl = opts.localDir
                        // patch icons in bundled packages
                        Object.keys(trg.bundledpkgs).forEach(pkgid => {
                            const res = trg.bundledpkgs[pkgid];
                            // path config before storing
                            const config = JSON.parse(res[pxt.CONFIG_NAME]) as pxt.PackageConfig;
                            if (/^\//.test(config.icon)) config.icon = opts.localDir + "docs" + config.icon;
                            res[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(config);
                        })
                        data = Buffer.from((isJs ? targetJsPrefix : '') + nodeutil.stringify(trg), "utf8")
                    } else {
                        if (trg.simulator
                            && trg.simulator.boardDefinition
                            && trg.simulator.boardDefinition.visual) {
                            let boardDef = trg.simulator.boardDefinition.visual as pxsim.BoardImageDefinition;
                            if (boardDef.image) {
                                boardDef.image = uploadArtFile(boardDef.image);
                                if (boardDef.outlineImage) boardDef.outlineImage = uploadArtFile(boardDef.outlineImage);
                            }
                        }
                        // patch icons in bundled packages
                        Object.keys(trg.bundledpkgs).forEach(pkgid => {
                            const res = trg.bundledpkgs[pkgid];
                            // path config before storing
                            const config = JSON.parse(res[pxt.CONFIG_NAME]) as pxt.PackageConfig;
                            if (config.icon) config.icon = uploadArtFile(config.icon);
                            res[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(config);
                        })
                        content = nodeutil.stringify(trg);
                        if (isJs)
                            content = targetJsPrefix + content
                    }
                }
            } else {
                content = data.toString("base64")
            }
            return Promise.resolve()
        }).then(() => {

            if (opts.localDir) {
                U.assert(!!opts.builtPackaged);
                let fn = path.join(opts.builtPackaged, opts.localDir, fileName)
                nodeutil.mkdirP(path.dirname(fn))
                return minified ? writeFileAsync(fn, content) : writeFileAsync(fn, data)
            }

            let req = {
                encoding: isText ? "utf8" : "base64",
                content,
                hash: "",
                filename: fileName,
                size: 0
            }
            let buf = Buffer.from(req.content, req.encoding)
            req.size = buf.length
            req.hash = gitHash(buf)
            uplReqs[fileName] = req
            return Promise.resolve()
        })
    }

    // only keep the last version of each uploadFileName()
    opts.fileList = U.values(U.toDictionary(opts.fileList, uploadFileName))

    // check size
    const maxSize = checkFileSize(opts.fileList);
    if (maxSize > 30000000) // 30Mb max
        U.userError(`file too big for upload`);
    pxt.log('');

    if (opts.localDir)
        return Promise.map(opts.fileList, uploadFileAsync, { concurrency: 15 })
            .then(() => {
                pxt.log("Release files written to " + path.join(opts.builtPackaged, opts.localDir))
            })

    return Promise.map(opts.fileList, uploadFileAsync, { concurrency: 15 })
        .then(() =>
            opts.githubOnly
                ? uploadToGitRepoAsync(opts, uplReqs)
                : gitUploadAsync(opts, uplReqs))
}

function readLocalPxTarget() {
    if (!fs.existsSync("pxtarget.json")) {
        console.error("This command requires pxtarget.json in current directory.")
        process.exit(1)
    }
    nodeutil.setTargetDir(process.cwd())
    const cfg: pxt.TargetBundle = readJson("pxtarget.json");
    cfg.versions = {
        target: readJson("package.json")["version"]
    };

    return cfg
}

function forEachBundledPkgAsync(f: (pkg: pxt.MainPackage, dirname: string) => Promise<void>, includeProjects: boolean = false) {
    let prev = process.cwd()
    let folders = pxt.appTarget.bundleddirs;

    if (includeProjects) {
        let projects = nodeutil.allFiles("libs", 1, /*allowMissing*/ false, /*includeDirs*/ true).filter(f => /prj$/.test(f));
        folders = folders.concat(projects);
    }

    return Promise.mapSeries(folders, (dirname) => {
        const host = new Host();
        const pkgPath = path.join(nodeutil.targetDir, dirname);
        pxt.debug(`building bundled package at ${pkgPath}`)

        // if the package is under node_modules/ , slurp any existing files
        const m = /node_modules[\\\/][^\\\/]*[\\\/]libs[\\\/](\w+)$/i.exec(pkgPath);
        if (m) {
            const bdir = m[1];
            const overridePath = path.join("libs", bdir);
            pxt.debug(`override with files from ${overridePath}`)
            if (nodeutil.existsDirSync(overridePath)) {
                host.fileOverrides = {};
                nodeutil.allFiles(overridePath)
                    .filter(f => fs.existsSync(f))
                    .forEach(f => host.fileOverrides[path.relative(overridePath, f)] = fs.readFileSync(f, "utf8"));

                pxt.debug(`file overrides: ${Object.keys(host.fileOverrides).join(', ')}`)
            } else {
                pxt.debug(`override folder ${overridePath} not present`);
            }
        }

        process.chdir(pkgPath);
        mainPkg = new pxt.MainPackage(host);
        return f(mainPkg, dirname);
    })
        .finally(() => process.chdir(prev))
        .then(() => { });
}

function ghpSetupRepoAsync() {
    function getreponame() {
        let cfg = fs.readFileSync("gh-pages/.git/config", "utf8")
        let m = /^\s*url\s*=\s*.*github.*\/([^\/\s]+)$/mi.exec(cfg)
        if (!m) U.userError("cannot determine GitHub repo name")
        return m[1].replace(/\.git$/, "")
    }
    if (fs.existsSync("gh-pages")) {
        console.log("Skipping init of gh-pages; you can delete it first to get full re-init")
        return Promise.resolve(getreponame())
    }

    nodeutil.cpR(".git", "gh-pages/.git")
    return ghpGitAsync("checkout", "gh-pages")
        .then(() => getreponame())
}

function ghpGitAsync(...args: string[]) {
    return nodeutil.spawnAsync({
        cmd: "git",
        cwd: "gh-pages",
        args: args
    })
}

function ghpInitAsync() {
    if (fs.existsSync("gh-pages/.git"))
        return Promise.resolve();

    nodeutil.cpR(".git", "gh-pages/.git")
    return ghpGitAsync("checkout", "gh-pages")
        .then(() => Promise.resolve()) // branch already exists

        .catch((e: any) => ghpGitAsync("checkout", "--orphan", "gh-pages"))
        .then(() => ghpGitAsync("rm", "-rf", "."))
        .then(() => {
            nodeutil.writeFileSync("gh-pages/index.html", "Under construction.")
            nodeutil.writeFileSync("gh-pages/.gitattributes",
                `# enforce unix style line endings
*.ts text eol=lf
*.tsx text eol=lf
*.md text eol=lf
*.txt text eol=lf
*.js text eol=lf
*.json text eol=lf
*.xml text eol=lf
*.svg text eol=lf
*.yaml text eol=lf
*.css text eol=lf
*.html text eol=lf
*.py text eol=lf
*.exp text eol=lf
*.manifest text eol=lf

# do not enforce text for everything - it causes issues with random binary files

*.sln text eol=crlf

*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
`);
            return ghpGitAsync("add", ".")
        })
        .then(() => ghpGitAsync("commit", "-m", "Initial."))
        .then(() => ghpGitAsync("push", "--set-upstream", "origin", "gh-pages"))
}

export function ghpPushAsync(builtPackaged: string, minify = false) {
    let repoName = ""
    return ghpInitAsync()
        .then(() => ghpSetupRepoAsync())
        .then(name => internalStaticPkgAsync(builtPackaged, (repoName = name), minify))
        .then(() => nodeutil.cpR(path.join(builtPackaged, repoName), "gh-pages"))
        .then(() => ghpGitAsync("add", "."))
        .then(() => ghpGitAsync("commit", "-m", "Auto-push"))
        .then(() => ghpGitAsync("push"))
}

function maxMTimeAsync(dirs: string[]) {
    let max = 0
    return Promise.map(dirs, dn => readDirAsync(dn)
        .then(files => Promise.map(files, fn => statAsync(path.join(dn, fn))
            .then(st => {
                max = Math.max(st.mtime.getTime(), max)
            }))))
        .then(() => max)
}

export interface BuildTargetOptions {
    localDir?: boolean;
    packaged?: boolean;
    skipCore?: boolean;
    quick?: boolean;
    rebundle?: boolean;
}

export function buildTargetAsync(parsed?: commandParser.ParsedCommand): Promise<void> {
    parseBuildInfo(parsed);
    const opts: BuildTargetOptions = {};
    if (parsed && parsed.flags["skipCore"])
        opts.skipCore = true;
    const clean = parsed && parsed.flags["clean"];
    return (clean ? cleanAsync() : Promise.resolve())
        .then(() => internalBuildTargetAsync(opts));
}

export function internalBuildTargetAsync(options: BuildTargetOptions = {}): Promise<void> {
    if (pxt.appTarget.id == "core")
        return buildTargetCoreAsync(options)

    let initPromise: Promise<void>;

    const commonPackageDir = path.resolve("node_modules/pxt-common-packages")

    // Make sure to build common sim in case of a local clean. This will do nothing for
    // targets without pxt-common-packages installed.
    if (!inCommonPkg("built/common-sim.js") || !inCommonPkg("built/common-sim.d.ts")) {
        initPromise = buildCommonSimAsync();
    }
    else {
        initPromise = Promise.resolve();
    }

    if (nodeutil.existsDirSync(simDir()))
        initPromise = initPromise.then(() => extractLocStringsAsync("sim-strings", [simDir()]));

    return initPromise
        .then(() => { copyCommonSim(); return simshimAsync() })
        .then(() => buildFolderAsync('compiler', true, 'compiler'))
        .then(() => fillInCompilerExtension(pxt.appTarget))
        .then(() => options.rebundle ? buildTargetCoreAsync({ quick: true }) : buildTargetCoreAsync(options))
        .then(() => buildSimAsync())
        .then(() => buildFolderAsync('cmds', true))
        .then(() => buildSemanticUIAsync())
        .then(() => buildEditorExtensionAsync("editor", "extendEditor"))
        .then(() => buildEditorExtensionAsync("fieldeditors", "extendFieldEditors"))
        .then(() => buildFolderAsync('server', true, 'server'))

    function inCommonPkg(p: string) {
        return fs.existsSync(path.join(commonPackageDir, p));
    }
}

function buildEditorExtensionAsync(dirname: string, optionName: string) {
    if (pxt.appTarget.appTheme && (pxt.appTarget.appTheme as any)[optionName] &&
        fs.existsSync(path.join(dirname, "tsconfig.json"))) {
        const tsConfig = JSON.parse(fs.readFileSync(path.join(dirname, "tsconfig.json"), "utf8"));
        let p: Promise<void>;
        if (tsConfig.compilerOptions.module)
            p = buildFolderAndBrowserifyAsync(dirname, true, dirname);
        else
            p = buildFolderAsync(dirname, true, dirname);
        return p.then(() => {
            const prepends = nodeutil.allFiles(path.join(dirname, "prepend"), 1, true)
                .filter(f => /\.js$/.test(f));
            if (prepends && prepends.length) {
                const editorjs = path.join("built", dirname + ".js");
                prepends.push(editorjs);
                pxt.log(`bundling ${prepends.join(', ')}`);
                const bundled = prepends.map(f => fs.readFileSync(f, "utf8")).join("\n");
                fs.writeFileSync(editorjs, bundled, "utf8");
            }
        })
    }
    return Promise.resolve();
}

function buildFolderAsync(p: string, optional?: boolean, outputName?: string): Promise<void> {
    if (!fs.existsSync(path.join(p, "tsconfig.json"))) {
        if (!optional) U.userError(`${p}/tsconfig.json not found`);
        return Promise.resolve()
    }

    const tsConfig = JSON.parse(fs.readFileSync(path.join(p, "tsconfig.json"), "utf8"));
    let isNodeModule = false;
    if (outputName && tsConfig.compilerOptions.out !== `../built/${outputName}.js`) {
        // Special case to support target sim as an NPM package
        if (/^node_modules[\/\\]+pxt-.*?-sim$/.test(p)) {
            // Allow the out dir be inside the folder being built, and manually copy the result to ./built afterwards
            if (tsConfig.compilerOptions.out !== `./built/${outputName}.js`) {
                U.userError(`${p}/tsconfig.json expected compilerOptions.out:"./built/${outputName}.js", got "${tsConfig.compilerOptions.out}"`);
            }
            isNodeModule = true;
        } else {
            U.userError(`${p}/tsconfig.json expected compilerOptions.out:"../built/${outputName}.js", got "${tsConfig.compilerOptions.out}"`);
        }
    }

    if (!fs.existsSync("node_modules/typescript")) {
        U.userError("Oops, typescript does not seem to be installed, did you run 'npm install'?");
    }

    pxt.log(`building ${p}...`)
    dirsToWatch.push(p)
    return nodeutil.spawnAsync({
        cmd: "node",
        args: [`../${isNodeModule ? "" : "node_modules/"}typescript/bin/tsc`],
        cwd: p
    }).then(() => {
        if (tsConfig.prepend) {
            let files: string[] = tsConfig.prepend
            files.push(tsConfig.compilerOptions.out)
            let s = ""
            for (let f of files) {
                s += fs.readFileSync(path.resolve(p, f), "utf8") + "\n"
            }
            fs.writeFileSync(path.resolve(p, tsConfig.compilerOptions.out), s)
        }

        if (isNodeModule) {
            const content = fs.readFileSync(path.resolve(p, tsConfig.compilerOptions.out), "utf8");
            fs.writeFileSync(path.resolve("built", path.basename(tsConfig.compilerOptions.out)), content);
        }
    })
}

function copyCommonSim() {
    const p = "node_modules/pxt-common-packages/built";
    if (fs.existsSync(p)) {
        pxt.log(`copying common-sim...`)
        nodeutil.cp(path.join(p, "common-sim.js"), "built");
        nodeutil.cp(path.join(p, "common-sim.d.ts"), "built");
    }
}

function buildFolderAndBrowserifyAsync(p: string, optional?: boolean, outputName?: string): Promise<void> {
    if (!fs.existsSync(path.join(p, "tsconfig.json"))) {
        if (!optional) U.userError(`${p}/tsconfig.json not found`);
        return Promise.resolve()
    }

    const tsConfig = JSON.parse(fs.readFileSync(path.join(p, "tsconfig.json"), "utf8"));
    if (outputName && tsConfig.compilerOptions.outDir !== `../built/${outputName}`) {
        U.userError(`${p}/tsconfig.json expected compilerOptions.ourDir:"../built/${outputName}", got "${tsConfig.compilerOptions.outDir}"`);
    }

    if (!fs.existsSync("node_modules/typescript")) {
        U.userError("Oops, typescript does not seem to be installed, did you run 'npm install'?");
    }

    pxt.log(`building ${p}...`)
    dirsToWatch.push(p)
    return nodeutil.spawnAsync({
        cmd: "node",
        args: ["../node_modules/typescript/bin/tsc"],
        cwd: p
    }).then(() => {
        const browserify = require('browserify');
        let b = browserify();
        nodeutil.allFiles(`built/${outputName}`).forEach((f) => {
            if (f.match(/\.js$/)) {
                b.add(f);
            }
        });

        let outFile = fs.createWriteStream(`built/${outputName}.js`, { encoding: 'utf8' });
        b.bundle().pipe(outFile);

        return new Promise<void>((resolve, reject) => {
            outFile.on('finish', () => {
                resolve();
            });
            outFile.on('error', (err: any) => {
                reject(err);
            });
        });
    })
}

let dirsToWatch: string[] = []

interface CiBuildInfo {
    ci: "travis" | "githubactions" | "local"
    branch: string;
    tag: string;
    commit: string;
    commitUrl: string;
    pullRequest?: boolean;
}

function ciBuildInfo(): CiBuildInfo {
    const isTravis = (process.env.TRAVIS === "true");
    const isGithubAction = (!!process.env.GITHUB_ACTIONS);
    const isAzurePipelines = (process.env.TF_BUILD === "True");

    if (isTravis) return travisInfo();
    else if (isGithubAction) return githubActionInfo();
    else if (isAzurePipelines) return travisInfo(); // azure pipelines uses same info
    else {
        // local build
        return {
            ci: "local",
            branch: undefined,
            tag: undefined,
            commit: undefined,
            commitUrl: undefined
        }
    }

    function travisInfo(): CiBuildInfo {
        const commit = process.env.TRAVIS_COMMIT;
        const pr = process.env.TRAVIS_PULL_REQUEST;
        const repoSlug = process.env.TRAVIS_REPO_SLUG;
        return {
            ci: "travis",
            branch: process.env.TRAVIS_BRANCH,
            tag: process.env.TRAVIS_TAG,
            commit,
            commitUrl: !commit ? undefined :
                "https://github.com/" + repoSlug + "/commits/" + commit,
            pullRequest: pr !== "false"
        }
    }

    function githubActionInfo(): CiBuildInfo {
        // https://help.github.com/en/actions/automating-your-workflow-with-github-actions/using-environment-variables#default-environment-variables
        const repoSlug = process.env.GITHUB_REPOSITORY;
        const commit = process.env.GITHUB_SHA;
        const ref = process.env.GITHUB_REF;
        // branch build refs/heads/...
        // tag build res/tags/...
        const branch = ref.replace(/^refs\/(heads|tags)\//, '');
        const tag = /^refs\/tags\//.test(ref) ? branch : undefined;
        const eventName = process.env.GITHUB_EVENT_NAME;

        pxt.log(`event name: ${eventName}`);

        // PR: not on master or not a release number
        return {
            ci: "githubactions",
            branch,
            tag,
            commit,
            commitUrl: "https://github.com/" + repoSlug + "/commits/" + commit,
            pullRequest: !(branch == "master" || /^v\d+\.\d+\.\d+$/.test(tag))
        }
    }
}

function setCiBuildInfo(tag: string, branch: string, commit: string, repoSlug: string) {
    // travis
    process.env["TRAVIS"] = "1";
    process.env["TRAVIS_TAG"] = tag;
    process.env['TRAVIS_BRANCH'] = branch;
    process.env['TRAVIS_COMMIT'] = commit;
    process.env['TRAVIS_REPO_SLUG'] = repoSlug;
}

function buildWebManifest(cfg: pxt.TargetBundle) {
    let webmanifest: any = {
        "lang": "en",
        "dir": "ltr",
        "name": cfg.name,
        "short_name": cfg.nickname || cfg.name,
        "background_color": "#FAFAFA",
        "icons": [],
        "scope": "/",
        "start_url": "/",
        "display": "standalone",
        "orientation": "landscape"
    }
    if (cfg.appTheme) {
        if (cfg.appTheme.accentColor)
            webmanifest["theme_color"] = cfg.appTheme.accentColor;
        if (cfg.appTheme.backgroundColor)
            webmanifest["background_color"] = cfg.appTheme.backgroundColor;
    }
    [192, 512].forEach(sz => {
        const fn = `/static/icons/android-chrome-${sz}x${sz}.png`;
        if (fs.existsSync(path.join('docs', fn))) {
            webmanifest.icons.push({
                "src": uploadArtFile(fn),
                "sizes": `${sz}x${sz}`,
                "types": `image/png`
            })
        }
    });
    let diskManifest: any = {}
    if (fs.existsSync("webmanifest.json"))
        diskManifest = nodeutil.readJson("webmanifest.json")
    U.jsonCopyFrom(webmanifest, diskManifest)
    return webmanifest;
}

function processLf(filename: string, translationStrings: pxt.Map<string>): void {
    if (!/\.(ts|tsx|html)$/.test(filename)) return
    if (/\.d\.ts$/.test(filename)) return

    pxt.debug(`extracting strings from ${filename}`);
    fs.readFileSync(filename, { encoding: "utf8" })
        .split('\n').forEach((line, idx) => {
            function err(msg: string) {
                console.error(`${filename}(${idx}): ${msg}`);
            }
            while (true) {
                const newLine = line.replace(/\blf(_va)?\s*\(\s*(.*)/, (all, a, args) => {
                    const m = /^("([^"]|(\\"))+")\s*[\),]/.exec(args)
                    if (m) {
                        try {
                            const str = JSON.parse(m[1])
                            translationStrings[str] = str;
                        } catch (e) {
                            err("cannot JSON-parse " + m[1])
                        }
                    } else {
                        if (!/util\.ts$/.test(filename))
                            err("invalid format of lf() argument: " + args)
                    }
                    return "BLAH " + args
                })
                if (newLine == line) return;
                line = newLine
            }
        })
}

function getGalleryUrl(props: pxt.GalleryProps | string): string {
    return typeof props === "string" ? props : props.url
}

function saveThemeJson(cfg: pxt.TargetBundle, localDir?: boolean, packaged?: boolean) {
    cfg.appTheme.id = cfg.id
    cfg.appTheme.title = cfg.title
    cfg.appTheme.name = cfg.name
    cfg.appTheme.description = cfg.description

    let logos = (cfg.appTheme as any as Map<string>);
    if (packaged) {
        Object.keys(logos)
            .filter(k => /(logo|hero)$/i.test(k) && /^\.\//.test(logos[k]))
            .forEach(k => {
                logos[k] = path.join('./docs', logos[k]).replace(/\\/g, "/");
            })
    } else if (!localDir) {
        Object.keys(logos)
            .filter(k => /(logo|hero)$/i.test(k) && /^\.\//.test(logos[k]))
            .forEach(k => {
                logos[k] = uploadArtFile(logos[k]);
            })
    }

    if (!cfg.appTheme.htmlDocIncludes)
        cfg.appTheme.htmlDocIncludes = {}

    if (fs.existsSync("built/templates.json")) {
        cfg.appTheme.htmlTemplates = readJson("built/templates.json")
    }

    // extract strings from theme for target
    const theme = cfg.appTheme;
    let targetStrings: pxt.Map<string> = {};
    if (theme.title) targetStrings[theme.title] = theme.title;
    if (theme.name) targetStrings[theme.name] = theme.name;
    if (theme.description) targetStrings[theme.description] = theme.description;
    // walk options in pxt.json
    // patch icons in bundled packages
    Object.keys(cfg.bundledpkgs).forEach(pkgid => {
        const res = cfg.bundledpkgs[pkgid];
        // path config before storing
        const config = JSON.parse(res[pxt.CONFIG_NAME]) as pxt.PackageConfig;
        if (config.description) targetStrings[config.description] = config.description;
        if (config.yotta && config.yotta.userConfigs) {
            config.yotta.userConfigs
                .filter(userConfig => userConfig.description)
                .forEach(userConfig => targetStrings[userConfig.description] = userConfig.description);
        }
    })

    // extract strings from docs
    function walkDocs(docs: pxt.DocMenuEntry[]) {
        if (!docs) return;
        docs.forEach(doc => {
            targetStrings[doc.name] = doc.name;
            walkDocs(doc.subitems);
        })
    }
    walkDocs(theme.docMenu);
    if (nodeutil.fileExistsSync("targetconfig.json")) {
        const targetConfig = nodeutil.readJson("targetconfig.json") as pxt.TargetConfig;
        if (targetConfig && targetConfig.galleries) {
            const docsRoot = nodeutil.targetDir;
            let gcards: pxt.CodeCard[] = [];
            let tocmd: string =
                `# Projects

`;
            Object.keys(targetConfig.galleries).forEach(k => {
                targetStrings[k] = k;
                const galleryUrl = getGalleryUrl(targetConfig.galleries[k])
                const gallerymd = nodeutil.resolveMd(docsRoot, galleryUrl);
                const gallery = pxt.gallery.parseGalleryMardown(gallerymd);
                const gurl = `/${galleryUrl.replace(/^\//, '')}`;
                tocmd +=
                    `* [${k}](${gurl})
`;
                const gcard: pxt.CodeCard = {
                    name: k,
                    url: gurl
                };
                gcards.push(gcard)
                gallery.forEach(cards => cards.cards
                    .forEach(card => {
                        if (card.imageUrl && !gcard.imageUrl)
                            gcard.imageUrl = card.imageUrl;
                        if (card.largeImageUrl && !gcard.largeImageUrl)
                            gcard.largeImageUrl = card.largeImageUrl;
                        if (card.videoUrl && !gcard.videoUrl)
                            gcard.videoUrl = card.videoUrl;
                        const url = card.url || card.learnMoreUrl || card.buyUrl || (card.youTubeId && `https://youtu.be/${card.youTubeId}`);
                        tocmd += `  * [${card.name || card.title}](${url})
`;
                        if (card.tags)
                            card.tags.forEach(tag => targetStrings[tag] = tag);
                    }))
            });

            nodeutil.writeFileSync(path.join(docsRoot, "docs/projects/SUMMARY.md"), tocmd, { encoding: "utf8" });
            nodeutil.writeFileSync(path.join(docsRoot, "docs/projects.md"),
                `# Projects

\`\`\`codecard
${JSON.stringify(gcards, null, 4)}
\`\`\`

## See Also

${gcards.map(gcard => `[${gcard.name}](${gcard.url})`).join(',\n')}

`, { encoding: "utf8" });
        }
    }
    // extract strings from editor
    ["editor", "fieldeditors", "cmds"]
        .filter(d => nodeutil.existsDirSync(d))
        .forEach(d => nodeutil.allFiles(d)
            .forEach(f => processLf(f, targetStrings))
        );
    let targetStringsSorted: pxt.Map<string> = {};
    Object.keys(targetStrings).sort().map(k => targetStringsSorted[k] = k);

    // write files
    nodeutil.mkdirP("built");
    nodeutil.writeFileSync("built/theme.json", nodeutil.stringify(cfg.appTheme))
    nodeutil.writeFileSync("built/target-strings.json", nodeutil.stringify(targetStringsSorted))
    pxt.log(`target-strings.json built`)
}

function buildSemanticUIAsync(parsed?: commandParser.ParsedCommand) {
    const forceRedbuild = parsed && parsed.flags["force"] || false;
    if (!fs.existsSync(path.join("theme", "style.less")) ||
        !fs.existsSync(path.join("theme", "theme.config")))
        return Promise.resolve();

    let dirty = !fs.existsSync("built/web/semantic.css");
    if (!dirty) {
        const csstime = fs.statSync("built/web/semantic.css").mtime;
        dirty = nodeutil.allFiles("theme")
            .map(f => fs.statSync(f))
            .some(stat => stat.mtime > csstime);
    }

    if (!dirty && !forceRedbuild) return Promise.resolve();

    let pkg = readJson("package.json")

    nodeutil.mkdirP(path.join("built", "web"));
    const lessPath = require.resolve('less');
    const lessCPath = path.join(path.dirname(lessPath), '/bin/lessc');
    return nodeutil.spawnAsync({
        cmd: "node",
        args: [lessCPath, "theme/style.less", "built/web/semantic.css", "--include-path=node_modules/semantic-ui-less:node_modules/pxt-core/theme:theme/foo/bar"]
    }).then(() => {
        const fontFile = fs.readFileSync("node_modules/semantic-ui-less/themes/default/assets/fonts/icons.woff")
        const url = "url(data:application/font-woff;charset=utf-8;base64,"
            + fontFile.toString("base64") + ") format('woff')"
        let semCss = fs.readFileSync('built/web/semantic.css', "utf8")
        semCss = semCss.replace('src: url("fonts/icons.eot");', "")
            .replace(/src:.*url\("fonts\/icons\.woff.*/g, "src: " + url + ";")
        return semCss;
    }).then((semCss) => {
        // Append icons.css to semantic.css (custom pxt icons)
        const iconsFile = (pkg["name"] == "pxt-core") ? 'built/web/icons.css' : 'node_modules/pxt-core/built/web/icons.css';
        const iconsCss = fs.readFileSync(iconsFile, "utf-8");
        semCss = semCss + "\n" + iconsCss;
        nodeutil.writeFileSync('built/web/semantic.css', semCss);
    }).then(() => {
        // generate blockly css
        if (!fs.existsSync(path.join("theme", "blockly.less")))
            return Promise.resolve();
        return nodeutil.spawnAsync({
            cmd: "node",
            args: [lessCPath, "theme/blockly.less", "built/web/blockly.css", "--include-path=node_modules/semantic-ui-less:node_modules/pxt-core/theme:theme/foo/bar"]
        })
    }).then(() => {
        // run postcss with autoprefixer and rtlcss
        pxt.debug("running postcss");
        const postcss = require('postcss');
        const browserList = [
            "Chrome >= 38",
            "Firefox >= 31",
            "Edge >= 12",
            "ie >= 11",
            "Safari >= 9",
            "Opera >= 21",
            "iOS >= 9",
            "ChromeAndroid >= 59",
            "FirefoxAndroid >= 55"
        ]
        const cssnano = require('cssnano')({
            zindex: false,
            autoprefixer: { browsers: browserList, add: true }
        });
        const rtlcss = require('rtlcss');
        const files = ['semantic.css', 'blockly.css']
        files.forEach(cssFile => {
            fs.readFile(`built/web/${cssFile}`, "utf8", (err, css) => {
                postcss([cssnano])
                    .process(css, { from: `built/web/${cssFile}`, to: `built/web/${cssFile}` }).then((result: any) => {
                        fs.writeFile(`built/web/${cssFile}`, result.css, (err2) => {
                            // process rtl css
                            postcss([rtlcss])
                                .process(result.css, { from: `built/web/${cssFile}`, to: `built/web/rtl${cssFile}` }).then((result2: any) => {
                                    nodeutil.writeFileSync(`built/web/rtl${cssFile}`, result2.css, { encoding: "utf8" });
                                });
                        });
                    });
            })
        });
    })
}

function buildWebStringsAsync() {
    if (pxt.appTarget.id != "core") return Promise.resolve();

    nodeutil.writeFileSync("built/webstrings.json", nodeutil.stringify(webstringsJson()))
    return Promise.resolve()
}

function thirdPartyNoticesAsync(parsed: commandParser.ParsedCommand): Promise<void> {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    let tpn = `
/*!----------------- MakeCode (PXT) ThirdPartyNotices -------------------------------------------------------

MakeCode (PXT) uses third party material from the projects listed below.
The original copyright notice and the license under which Microsoft
received such third party material are set forth below. Microsoft
reserves all other rights not expressly granted, whether by
implication, estoppel or otherwise.

In the event that we accidentally failed to list a required notice, please
bring it to our attention. Post an issue or email us:

           makecode@microsoft.com

---------------------------------------------
Third Party Code Components
---------------------------------------------

    `;

    function lic(dep: string) {
        const license = path.join("node_modules", dep, "LICENSE");
        if (fs.existsSync(license))
            return fs.readFileSync(license, 'utf8');
        const readme = fs.readFileSync("README.md", "utf8");
        const lic = /## License([^#]+)/.exec(readme);
        if (lic)
            return lic[1];

        return undefined;
    }

    for (const dep of Object.keys(pkg.dependencies).concat(Object.keys(pkg.devDependencies))) {
        pxt.log(`scanning ${dep}`)
        const license = lic(dep);
        if (!license)
            pxt.log(`no license for ${dep} at ${license}`);
        else
            tpn += `
----------------- ${dep} -------------------

${license}

---------------------------------------------
`
    }

    tpn += `
------------- End of ThirdPartyNotices --------------------------------------------------- */`;

    nodeutil.writeFileSync("THIRD-PARTY-NOTICES.txt", tpn, { encoding: 'utf8' });
    return Promise.resolve();
}

function updateDefaultProjects(cfg: pxt.TargetBundle) {
    let defaultProjects = [
        pxt.BLOCKS_PROJECT_NAME,
        pxt.JAVASCRIPT_PROJECT_NAME
    ];

    nodeutil.allFiles("libs", 1, /*allowMissing*/ false, /*includeDirs*/ true)
        .filter((f) => {
            return defaultProjects.indexOf(path.basename(f)) !== -1;
        })
        .forEach((projectPath) => {
            let projectId = path.basename(projectPath);
            let newProject: pxt.ProjectTemplate = {
                id: projectId,
                config: {
                    name: "",
                    dependencies: {},
                    files: []
                },
                files: {}
            };

            nodeutil.allFiles(projectPath).forEach((f) => {
                let relativePath = path.relative(projectPath, f); // nodeutil.allFiles returns libs/blocksprj/path_to_file, this removes libs/blocksprj/
                let fileName = path.basename(relativePath);

                if (/^((built)|(pxt_modules)|(node_modules))[\/\\]/.test(relativePath) || fileName === "tsconfig.json") {
                    return;
                }

                if (fileName === pxt.CONFIG_NAME) {
                    newProject.config = nodeutil.readPkgConfig(projectPath);
                    U.iterMap(newProject.config.dependencies, (k, v) => {
                        if (/^file:/.test(v)) {
                            newProject.config.dependencies[k] = "*";
                        }
                    });
                    if (newProject.config.icon)
                        newProject.config.icon = uploadArtFile(newProject.config.icon);
                } else {
                    newProject.files[relativePath] = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
                }
            });

            (<any>cfg)[projectId] = newProject;
        });

    if (!cfg.tsprj && cfg.blocksprj) {
        let notBlock = (s: string) => !U.endsWith(s, ".blocks")
        cfg.tsprj = U.clone(cfg.blocksprj)
        cfg.tsprj.id = "tsprj"
        cfg.tsprj.config.files = cfg.tsprj.config.files.filter(notBlock)
        for (let k of Object.keys(cfg.tsprj.files)) {
            if (!notBlock(k)) delete cfg.tsprj.files[k]
        }
    }
}

function updateTOC(cfg: pxt.TargetBundle) {
    if (!cfg.appTheme) return; // no theme to update
    // Update Table of Contents from SUMMARY.md file
    const summaryMD = nodeutil.resolveMd(nodeutil.targetDir, "SUMMARY");
    if (!summaryMD) {
        pxt.log('no SUMMARY file found');
    } else {
        cfg.appTheme.TOC = pxt.docs.buildTOC(summaryMD)
    }
}

function rebundleAsync() {
    return buildTargetCoreAsync({ quick: true })
        .then(() => buildSimAsync());
}

function buildSimAsync() {
    return buildFolderAsync(simDir(), true, pxt.appTarget.id === "common" ? "common-sim" : "sim");
}

function compressApiInfo(inf: Map<pxt.PackageApiInfo>) {
    function leanSymbol(sym: pxtc.SymbolInfo) {
        const isEmpty = (v: any) => !v || Object.keys(v).length == 0
        let attrs: pxtc.CommentAttrs = U.clone(sym.attributes || ({} as any))
        if (attrs.callingConvention == 0)
            delete attrs.callingConvention
        if (isEmpty(attrs.paramDefl))
            delete attrs.paramDefl
        if (isEmpty(attrs.paramHelp))
            delete attrs.paramHelp
        if (!attrs.jsDoc)
            delete attrs.jsDoc
        if (attrs.iconURL && attrs.jres) {
            delete attrs.iconURL;
        }
        delete attrs._source
        // keep shim=ENUM_GET etc
        if (!attrs.shim || attrs.shim.indexOf("::") > 0)
            delete attrs.shim
        delete attrs._name
        if (isEmpty(attrs))
            attrs = undefined
        const kind = sym.snippet !== undefined ? -sym.kind : sym.kind
        const pyQName = sym.pyQName !== sym.qName ? sym.pyQName : undefined
        return {
            kind: kind == 7 ? undefined : kind,
            retType: sym.retType == "void" ? undefined : sym.retType,
            attributes: attrs,
            extendsTypes: sym.extendsTypes,
            parameters: sym.parameters ? sym.parameters.map(p => ({
                name: p.name,
                description: p.description || undefined,
                type: p.type == "number" ? undefined : p.type,
                initializer: p.initializer,
                default: p.default,
                options: isEmpty(p.options) ? undefined : p.options,
                isEnum: p.isEnum || undefined,
                handlerParameters: p.handlerParameters
            })) : undefined,
            isInstance: sym.isInstance || undefined,
            isReadOnly: sym.isReadOnly || undefined,
            pyQName: pyQName
        } as pxtc.SymbolInfo;
    }

    inf = U.clone(inf)

    for (const pkgName of Object.keys(inf)) {
        const byQName = inf[pkgName].apis.byQName
        for (const apiName of Object.keys(byQName)) {
            if (/^DAL\./.test(apiName))
                delete byQName[apiName]
            else
                byQName[apiName] = leanSymbol(byQName[apiName])
        }
    }

    return inf
}

function buildTargetCoreAsync(options: BuildTargetOptions = {}) {
    let cfg = readLocalPxTarget()
    updateDefaultProjects(cfg);
    updateTOC(cfg);
    cfg.bundledpkgs = {}
    pxt.setAppTarget(cfg);
    let statFiles: Map<number> = {}
    dirsToWatch = cfg.bundleddirs.slice()
    if (pxt.appTarget.id != "core") {
        if (fs.existsSync("theme")) {
            dirsToWatch.push("theme"); // simulator
            dirsToWatch.push(path.join("theme", "site", "globals")); // simulator
        }
        if (fs.existsSync("editor"))
            dirsToWatch.push("editor");
        if (fs.existsSync("fieldeditors"))
            dirsToWatch.push("fieldeditors");
        if (fs.existsSync(simDir())) {
            dirsToWatch.push(simDir()); // simulator
            dirsToWatch = dirsToWatch.concat(
                fs.readdirSync(simDir())
                    .map(p => path.join(simDir(), p))
                    .filter(p => path.basename(p) !== "built" && fs.statSync(p).isDirectory()));
        }
    }

    const hexCachePath = path.resolve(process.cwd(), "built", "hexcache");
    const apiInfoPath = path.resolve(process.cwd(), "temp", "api-cache.json");
    const apiInfoCompressedPath = path.resolve(process.cwd(), "temp", "api-cache-compressed.json");
    nodeutil.mkdirP(hexCachePath);

    pxt.log(`building target.json in ${process.cwd()}...`)

    let builtInfo: pxt.Map<pxt.PackageApiInfo> = {};

    if (!pxt.appTarget.appTheme.disableAPICache && fs.existsSync(apiInfoPath)) {
        builtInfo = nodeutil.readJson(apiInfoPath);
    }

    let coreDependencies: string[];
    const corepkg = "libs/" + pxt.appTarget.corepkg;

    return buildWebStringsAsync()
        .then(() => options.quick ? null : internalGenDocsAsync(false, true))
        .then(() => forEachBundledPkgAsync((pkg, dirname) => {
            pxt.log(`building bundled ${dirname}`);
            let isPrj = /prj$/.test(dirname);
            const isHw = /hw---/.test(dirname);
            const config = nodeutil.readPkgConfig(".")
            const isCore = !!config.core;
            for (let p of config.additionalFilePaths)
                dirsToWatch.push(path.resolve(p));

            return pkg.filesToBePublishedAsync(true)
                .then(res => {
                    if (!isPrj) {
                        cfg.bundledpkgs[path.basename(dirname)] = res
                    }
                    if (isHw) isPrj = true
                    if (isCore && pxt.appTarget.simulator &&
                        pxt.appTarget.simulator.dynamicBoardDefinition)
                        isPrj = true
                })
                .then(() => options.quick ? null : testForBuildTargetAsync(isPrj || (!options.skipCore && isCore), builtInfo[dirname] && builtInfo[dirname].sha))
                .then(res => {
                    if (!res)
                        return;

                    const { options, api, sha: packageSha } = res;
                    // For the projects, we need to save the base HEX file to the offline HEX cache
                    if (isPrj && pxt.appTarget.compile && pxt.appTarget.compile.hasHex) {
                        if (!options) {
                            pxt.debug(`Failed to extract native image for project ${dirname}`);
                            return;
                        }

                        // Place the base HEX image in the hex cache if necessary
                        let sha = options.extinfo.sha;
                        let hex: string[] = options.extinfo.hexinfo.hex;
                        let hexFile = path.join(hexCachePath, sha + ".hex");

                        if (fs.existsSync(hexFile)) {
                            pxt.debug(`native image already in offline cache for project ${dirname}: ${hexFile}`);
                        } else {
                            nodeutil.writeFileSync(hexFile, hex.join(os.EOL));
                            pxt.debug(`created native image in offline cache for project ${dirname}: ${hexFile}`);
                        }
                    }

                    if (options && api) {
                        // JRES is already included in the target bundle
                        api.jres = undefined;
                        builtInfo[dirname] = {
                            apis: api,
                            sha: packageSha
                        };

                        if (dirname === corepkg) {
                            coreDependencies = mainPkg.sortedDeps().map(p => p.config.name).filter(n => n !== pxt.appTarget.corepkg);
                        }
                    }
                });
        }, /*includeProjects*/ true))
        .then(() => {
            // patch icons in bundled packages
            Object.keys(cfg.bundledpkgs).forEach(pkgid => {
                const res = cfg.bundledpkgs[pkgid];
                // path config before storing
                const config = JSON.parse(res[pxt.CONFIG_NAME]) as pxt.PackageConfig;
                if (!config.icon)
                    // try known location
                    ['png', 'jpg'].map(ext => `/static/libs/${config.name}.${ext}`)
                        .filter(ip => fs.existsSync("docs" + ip))
                        .forEach(ip => config.icon = ip);

                res[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(config);
            })

            // Trim redundant API info from packages
            const coreInfo = builtInfo[corepkg];

            if (coreInfo) {
                // Don't bother with dependencies of the core package
                if (coreDependencies) {
                    coreDependencies
                        .map(dep => builtInfo["libs/" + dep])
                        .filter(bi => !!bi)
                        .forEach(bi => bi.apis.byQName = {});
                }

                Object.keys(builtInfo).filter(k => k !== corepkg).map(k => builtInfo[k]).forEach(info => {
                    deleteRedundantSymbols(coreInfo.apis.byQName, info.apis.byQName)
                });
            }

            nodeutil.writeFileSync(apiInfoPath, nodeutil.stringify(builtInfo));
            const compressedBuiltInfo = compressApiInfo(builtInfo);
            nodeutil.writeFileSync(apiInfoCompressedPath, nodeutil.stringify(compressedBuiltInfo));
            cfg.apiInfo = compressedBuiltInfo;

            const info = ciBuildInfo()
            cfg.versions = {
                branch: info.branch,
                tag: info.tag,
                commits: info.commitUrl,
                target: readJson("package.json")["version"],
                pxt: pxtVersion(),
                pxtCrowdinBranch: pxtCrowdinBranch(),
                targetCrowdinBranch: targetCrowdinBranch()
            }
            saveThemeJson(cfg, options.localDir, options.packaged)
            fillInCompilerExtension(cfg);

            const webmanifest = buildWebManifest(cfg)
            const targetjson = nodeutil.stringify(cfg)
            nodeutil.writeFileSync("built/target.json", targetjson)
            nodeutil.writeFileSync("built/target.js", targetJsPrefix + targetjson)
            pxt.setAppTarget(cfg) // make sure we're using the latest version
            let targetlight = U.flatClone(cfg)
            delete targetlight.bundleddirs;
            delete targetlight.bundledpkgs;
            delete targetlight.appTheme;
            delete targetlight.apiInfo;
            if (targetlight.compile)
                delete targetlight.compile.compilerExtension;
            const targetlightjson = nodeutil.stringify(targetlight);
            nodeutil.writeFileSync("built/targetlight.json", targetlightjson)
            nodeutil.writeFileSync("built/sim.webmanifest", nodeutil.stringify(webmanifest))
        })
        .then(() => {
            console.log("target.json built.")
        })
}

function fillInCompilerExtension(cfg: pxt.TargetBundle) {
    const compPath = path.join(nodeutil.targetDir, "built/compiler.js")
    if (fs.existsSync(compPath)) {
        const src = fs.readFileSync(compPath, "utf8");
        // remove top-level namespace declarations, so it evals() correctly
        cfg.compile.compilerExtension = src.replace(/^var \w+;$/gm, "");
    }
}

function deleteRedundantSymbols(core: pxt.Map<pxtc.SymbolInfo | pxt.JRes>, trg: pxt.Map<pxtc.SymbolInfo | pxt.JRes>) {
    const ignoredKeys = ["fileName", "pkg"]

    for (const key of Object.keys(trg)) {
        if (flatJSONEquals(core[key], trg[key])) delete trg[key];
    }

    function flatJSONEquals(a: any, b: any) {
        if (a === b) return true;

        const tp = typeof a;
        if (tp !== typeof b || tp !== "object") return false;

        const keysa = Object.keys(a).filter(k => ignoredKeys.indexOf(k) === -1);
        const keysb = Object.keys(b).filter(k => ignoredKeys.indexOf(k) === -1);

        if (keysa.length !== keysb.length) return false;

        for (const key of keysa) {
            if (keysb.indexOf(key) === -1) return false;
            if (!flatJSONEquals(a[key], b[key])) return false;
        }

        return true;
    }
}

function pxtVersion(): string {
    return pxt.appTarget.id == "core" ?
        readJson("package.json")["version"] :
        readJson("node_modules/pxt-core/package.json")["version"];
}

function pxtCrowdinBranch(): string {
    const theme = pxt.appTarget.id == "core" ?
        readJson("pxtarget.json").appTheme :
        readJson("node_modules/pxt-core/pxtarget.json").appTheme;
    return theme ? theme.crowdinBranch : undefined;
}

function targetCrowdinBranch(): string {
    const theme = readJson("pxtarget.json").appTheme;
    return theme ? theme.crowdinBranch : undefined;
}

function buildAndWatchAsync(f: () => Promise<string[]>): Promise<void> {
    let currMtime = Date.now()
    return f()
        .then(dirs => {
            if (globalConfig.noAutoBuild) return
            pxt.debug('watching ' + dirs.join(', ') + '...');
            let loop = () => {
                Promise.delay(1000)
                    .then(() => maxMTimeAsync(dirs))
                    .then(num => {
                        if (num > currMtime) {
                            currMtime = num
                            f()
                                .then(d => {
                                    dirs = d
                                    U.nextTick(loop)
                                })
                        } else {
                            U.nextTick(loop)
                        }
                    })
            }
            U.nextTick(loop)
        })

}

function buildFailed(msg: string, e: any) {
    console.log("")
    console.log("***")
    console.log("*** Build failed: " + msg)
    console.log(e.stack)
    console.log("***")
    console.log("")
}

function buildAndWatchTargetAsync(includeSourceMaps: boolean, rebundle: boolean) {
    if (fs.existsSync("pxt.json") &&
        !(fs.existsSync(path.join(simDir(), "tsconfig.json")) || nodeutil.existsDirSync(path.join(simDir(), "public")))) {
        console.log("No sim/tsconfig.json nor sim/public/; assuming npm installed package")
        return Promise.resolve()
    }

    const hasCommonPackages = fs.existsSync(path.resolve("node_modules/pxt-common-packages"));

    let simDirectories: string[] = [];
    if (hasCommonPackages) {
        const libsdir = path.resolve("node_modules/pxt-common-packages/libs");
        simDirectories = fs.readdirSync(libsdir).map(fn => path.join(libsdir, fn, "sim"));
        simDirectories = simDirectories.filter(fn => fs.existsSync(fn));
    }

    return buildAndWatchAsync(() => buildCommonSimAsync()
        .catch(e => buildFailed("common sim build failed: " + e.message, e))
        .then(() => internalBuildTargetAsync({ localDir: true, rebundle }))
        .catch(e => buildFailed("target build failed: " + e.message, e))
        .then(() => {
            let toWatch = dirsToWatch.slice();
            if (hasCommonPackages) {
                toWatch = toWatch.concat(simDirectories);
            }
            return toWatch.filter(d => fs.existsSync(d));
        }));
}

function buildCommonSimAsync() {
    const simPath = path.resolve("node_modules/pxt-common-packages/sim");
    if (fs.existsSync(simPath)) {
        return buildFolderAsync(simPath)
    }
    else {
        return Promise.resolve();
    }
}

function renderDocs(builtPackaged: string, localDir: string) {
    const dst = path.resolve(path.join(builtPackaged, localDir))

    nodeutil.cpR("node_modules/pxt-core/docfiles", path.join(dst, "/docfiles"))
    if (fs.existsSync("docfiles"))
        nodeutil.cpR("docfiles", dst + "/docfiles")

    const webpath = localDir
    let docsTemplate = server.expandDocFileTemplate("docs.html")
    docsTemplate = U.replaceAll(docsTemplate, "/cdn/", webpath)
    docsTemplate = U.replaceAll(docsTemplate, "/doccdn/", webpath)
    docsTemplate = U.replaceAll(docsTemplate, "/docfiles/", webpath + "docfiles/")
    docsTemplate = U.replaceAll(docsTemplate, "/--embed", webpath + "embed.js")

    const validatedDirs: Map<boolean> = {}

    const docFolders = ["node_modules/pxt-core/common-docs"];

    if (fs.existsSync("node_modules/pxt-common-packages/docs")) {
        docFolders.push("node_modules/pxt-common-packages/docs");
    }

    docFolders.push(...nodeutil.getBundledPackagesDocs());
    docFolders.push("docs");

    for (const docFolder of docFolders) {
        for (const f of nodeutil.allFiles(docFolder, 8)) {
            pxt.log(`rendering ${f}`)
            const pathUnderDocs = f.slice(docFolder.length + 1);
            let outputFile = path.join(dst, "docs", pathUnderDocs);

            const outputDir = path.dirname(outputFile);
            if (!validatedDirs[outputDir]) {
                nodeutil.mkdirP(outputDir);
                validatedDirs[outputDir] = true;
            }

            let buf = fs.readFileSync(f);
            if (/\.(md|html)$/.test(f)) {
                const fileData = buf.toString("utf8");
                let html = "";
                if (U.endsWith(f, ".md")) {
                    const md = nodeutil.resolveMd(
                        ".",
                        pathUnderDocs.slice(0, -3),
                        fileData
                    );
                    // patch any /static/... url to /docs/static/...
                    const patchedMd = md.replace(/\"\/static\//g, `"/docs/static/`);
                    nodeutil.writeFileSync(outputFile, patchedMd, { encoding: "utf8" });

                    html = pxt.docs.renderMarkdown({
                        template: docsTemplate,
                        markdown: patchedMd,
                        theme: pxt.appTarget.appTheme,
                        filepath: path.join("docs", pathUnderDocs),
                    });

                    // replace .md with .html for rendered page drop
                    outputFile = outputFile.slice(0, -3) + ".html";
                } else {
                    html = server.expandHtml(fileData);
                }

                html = html.replace(/(<a[^<>]*)\shref="(\/[^<>"]*)"/g, (f, beg, url) => {
                    return beg + ` href="${webpath}docs${url}.html"`
                });
                buf = Buffer.from(html, "utf8");
            }

            nodeutil.writeFileSync(outputFile, buf)
        }
        pxt.log(`All docs written from ${docFolder}.`);
    }
    pxt.log(`All docs written.`);
}

export function serveAsync(parsed: commandParser.ParsedCommand) {
    // always use a cloud build
    // in most cases, the user machine is not properly setup to
    // build a native binary and our CLI just looks broken
    // use --localbuild to force localbuild
    parseBuildInfo(parsed);

    let justServe = false
    let packaged = false
    let includeSourceMaps = false;

    if (parsed.flags["just"]) {
        justServe = true
    } else if (parsed.flags["pkg"]) {
        justServe = true
        packaged = true
    }
    const rebundle = !!parsed.flags["rebundle"];
    if (parsed.flags["noBrowser"]) {
        globalConfig.noAutoStart = true
    }
    if (parsed.flags["sourceMaps"]) {
        includeSourceMaps = true;
    }
    if (!globalConfig.localToken) {
        globalConfig.localToken = ts.pxtc.Util.guidGen();
        saveConfig()
    }
    let localToken = globalConfig.localToken;
    if (!fs.existsSync("pxtarget.json")) {
        //Specifically when the target is being used as a library
        let targetDepLoc = nodeutil.targetDir
        if (fs.existsSync(path.join(targetDepLoc, "pxtarget.json"))) {
            console.log(`Going to ${targetDepLoc}`)
            process.chdir(targetDepLoc)
        }
        else {
            let upper = path.join(__dirname, "../../..")
            if (fs.existsSync(path.join(upper, "pxtarget.json"))) {
                console.log("going to " + upper)
                process.chdir(upper)
            } else {
                U.userError("Cannot find pxtarget.json to serve.")
            }
        }
    }
    return (justServe ? Promise.resolve() : buildAndWatchTargetAsync(includeSourceMaps, rebundle))
        .then(() => server.serveAsync({
            autoStart: !globalConfig.noAutoStart,
            localToken,
            packaged,
            port: parsed.flags["port"] as number || 0,
            wsPort: parsed.flags["wsport"] as number || 0,
            hostname: parsed.flags["hostname"] as string || "",
            browser: parsed.flags["browser"] as string,
            serial: !parsed.flags["noSerial"] && !globalConfig.noSerial
        }))
}


const readFileAsync: any = Promise.promisify(fs.readFile)
const writeFileAsync: any = Promise.promisify(fs.writeFile)
const readDirAsync = Promise.promisify(fs.readdir)
const statAsync = Promise.promisify(fs.stat)
const rimrafAsync = Promise.promisify(rimraf);

let commonfiles: Map<string> = {}

class SnippetHost implements pxt.Host {
    //Global cache of module files
    files: Map<Map<string>> = {}
    cache: pxt.Map<string> = {};

    constructor(public name: string, public packageFiles: Map<string>, public extraDependencies: pxt.Map<string>, private includeCommon = false) { }

    resolve(module: pxt.Package, filename: string): string {
        pxt.log(`resolve ${module.id}. ${filename}`)
        return ""
    }

    readFile(module: pxt.Package, filename: string): string {
        if (filename == pxt.github.GIT_JSON)
            return null;

        if (this.files[module.id] && this.files[module.id][filename]) {
            return this.files[module.id][filename]
        }
        if (module.id == "this") {
            if (filename == "pxt.json") {
                let commonFiles = this.includeCommon ? [
                    "pxt-core.d.ts",
                    "pxt-helpers.ts",
                ] : []
                let packageFileNames = Object.keys(this.packageFiles)
                return JSON.stringify(<pxt.PackageConfig>{
                    "name": this.name.replace(/[^a-zA-z0-9]/g, ''),
                    "dependencies": this.dependencies(),
                    "description": "",
                    "public": true,
                    "yotta": {
                        "ignoreConflicts": true
                    },
                    "files": packageFileNames.concat(commonFiles)
                })
            }
            else if (filename in this.packageFiles) {
                return this.packageFiles[filename]
            }
        } else if (pxt.appTarget.bundledpkgs[module.id] && filename === pxt.CONFIG_NAME) {
            return pxt.appTarget.bundledpkgs[module.id][pxt.CONFIG_NAME];
        } else {
            const readFile = (filename: string) => {
                let ps = [
                    path.join(module.id, filename),
                    path.join('libs', module.id, filename),
                    path.join('libs', module.id, 'built', filename),
                ];
                for (let p of ps) {
                    try {
                        return fs.readFileSync(p, 'utf8')
                    }
                    catch (e) {
                    }
                }
                return null
            }

            let contents = readFile(filename)
            if (contents == null) {
                // try additional package location
                if (pxt.appTarget.bundledpkgs[module.id]) {
                    let f = readFile(pxt.CONFIG_NAME)
                    const modpkg = JSON.parse(f || "{}") as pxt.PackageConfig;
                    // TODO this seems to be dead code, additionalFilePath is removed from bundledpkgs
                    // why not just use bundledpkgs also for files?
                    if (modpkg.additionalFilePath) {
                        try {
                            const ad = path.join(modpkg.additionalFilePath.replace('../../', ''), filename);
                            pxt.debug(ad)
                            contents = fs.readFileSync(ad, 'utf8')
                        }
                        catch (e) {
                        }
                    }
                }
            }

            if (contents) {
                this.writeFile(module, filename, contents)
                return contents
            }
        }

        if (module.id === "this") {
            if (filename === "pxt-core.d.ts") {
                const contents = fs.readFileSync(path.join(this.getRepoDir(), "libs", "pxt-common", "pxt-core.d.ts"), 'utf8');
                this.writeFile(module, filename, contents);
                return contents;
            }
            else if (filename === "pxt-helpers.ts") {
                const contents = fs.readFileSync(path.resolve(this.getRepoDir(), "libs", "pxt-common", "pxt-helpers.ts"), 'utf8');
                this.writeFile(module, filename, contents);
                return contents;
            }
            else if (filename === "pxt-python.d.ts" || filename === "pxt-python-helpers.ts") {
                const contents = fs.readFileSync(path.resolve(this.getRepoDir(), "libs", "pxt-python", filename), 'utf8');
                this.writeFile(module, filename, contents);
                return contents;
            }
        }

        // might be ok
        return null;
    }

    private getRepoDir() {
        const cwd = process.cwd();
        const i = cwd.lastIndexOf(path.sep + "pxt" + path.sep);
        return cwd.substr(0, i + 5);
    }

    writeFile(module: pxt.Package, filename: string, contents: string) {
        if (!this.files[module.id]) {
            this.files[module.id] = {}
        }
        this.files[module.id][filename] = contents
    }

    getHexInfoAsync(extInfo: pxtc.ExtensionInfo): Promise<pxtc.HexInfo> {
        return pxt.hexloader.getHexInfoAsync(this, extInfo)
    }

    cacheStoreAsync(id: string, val: string): Promise<void> {
        this.cache[id] = val;
        return Promise.resolve()
    }

    cacheGetAsync(id: string): Promise<string> {
        return Promise.resolve(this.cache[id] || "")
    }

    downloadPackageAsync(pkg: pxt.Package): Promise<void> {
        return pkg.commonDownloadAsync()
            .then(resp => {
                if (resp) {
                    U.iterMap(resp, (fn: string, cont: string) => {
                        this.writeFile(pkg, fn, cont)
                    })
                }
            })
    }

    resolveVersionAsync(pkg: pxt.Package): Promise<string> {
        if (!/^file:/.test(pkg._verspec))
            pxt.log(`resolveVersionAsync(${pkg.id})`)
        return Promise.resolve("*")
    }

    private dependencies(): Map<string> {
        let stdDeps: Map<string> = {}
        for (const extraDep in this.extraDependencies) {
            const ver = this.extraDependencies[extraDep];
            stdDeps[extraDep] = ver == "*" ? `file:../${extraDep}` : ver;
        }
        return stdDeps
    }
}

class Host
    implements pxt.Host {
    fileOverrides: Map<string> = {}

    resolve(module: pxt.Package, filename: string) {
        //pxt.debug(`resolving ${module.level}:${module.id} -- ${filename} in ${path.resolve(".")}`)
        if (module.level == 0) {
            return "./" + filename
        } else if (module.verProtocol() == "file") {
            let fn = module.verArgument() + "/" + filename
            if (module.level > 1 && module.addedBy[0])
                fn = this.resolve(module.addedBy[0], fn)
            return fn
        } else {
            return "pxt_modules/" + module.id + "/" + filename
        }
    }

    readFile(module: pxt.Package, filename: string, skipAdditionalFiles?: boolean): string {
        const commonFile = U.lookup(commonfiles, filename)
        if (commonFile != null) return commonFile;

        const overFile = U.lookup(this.fileOverrides, filename)
        if (module.level == 0 && overFile != null) {
            pxt.debug(`found override for ${filename}`)
            return overFile;
        }

        const resolved = this.resolve(module, filename)
        const dir = path.dirname(resolved)
        if (filename == pxt.CONFIG_NAME)
            try {
                return nodeutil.stringify(nodeutil.readPkgConfig(dir))
            } catch (e) {
                return null
            }

        try {
            // pxt.debug(`reading ${resolved}`)
            return fs.readFileSync(resolved, "utf8")
        } catch (e) {
            if (!skipAdditionalFiles && module.config) {
                for (let addPath of module.config.additionalFilePaths || []) {
                    try {
                        // pxt.debug(`try read: ${path.join(dir, addPath, filename)}`)
                        return fs.readFileSync(path.join(dir, addPath, filename), "utf8")
                    } catch (e) {
                    }
                }
            }
            return null
        }
    }

    writeFile(module: pxt.Package, filename: string, contents: string): void {
        let p = this.resolve(module, filename)
        let check = (p: string) => {
            let dir = p.replace(/\/[^\/]+$/, "")
            if (dir != p) {
                check(dir)
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir)
                }
            }
        }
        check(p)
        if (U.endsWith(filename, ".uf2") || U.endsWith(filename, ".pxt64"))
            nodeutil.writeFileSync(p, contents, { encoding: "base64" })
        else if (U.endsWith(filename, ".elf"))
            nodeutil.writeFileSync(p, contents, {
                encoding: "base64",
                mode: 0o777
            })
        else
            nodeutil.writeFileSync(p, contents, { encoding: "utf8" })
    }

    getHexInfoAsync(extInfo: pxtc.ExtensionInfo): Promise<pxtc.HexInfo> {
        if (process.env["PXT_LOCAL_DOCKER_TEST"] === "yes") {
            const compileReq = JSON.parse(Buffer.from(extInfo.compileData, "base64").toString("utf8"))
            const mappedFiles =
                Object.keys(compileReq.replaceFiles).map(k => {
                    return {
                        name: k.replace(/^\/+/, ""),
                        text: compileReq.replaceFiles[k]
                    }
                })
            const cs = pxt.appTarget.compileService
            const dockerReq = {
                op: "buildex",
                files: mappedFiles,
                gittag: compileReq.tag,
                empty: true,
                hexfile: "build/" + cs.codalBinary + ".hex",
                platformio: false,
                clone: "https://github.com/" + cs.githubCorePackage,
                buildcmd: "python build.py",
                image: "pext/yotta:latest"
            }

            const fn = "built/dockerreq.json"
            nodeutil.writeFileSync(fn, JSON.stringify(dockerReq, null, 4))
        }

        if (pxt.options.debug) {
            const compileReq = JSON.parse(Buffer.from(extInfo.compileData, "base64").toString("utf8"))
            const replLong = (m: any) => {
                for (let k of Object.keys(m)) {
                    let v = m[k]
                    if (typeof v == "string" && v.length > 200) {
                        m[k] = v.slice(0, 100) + " ... " + U.sha256(v).slice(0, 10)
                    } else if (v && typeof v == "object") {
                        replLong(v)
                    }
                }
            }
            replLong(compileReq)
            nodeutil.writeFileSync("built/cpp.json", nodeutil.stringify(compileReq))
        }

        if (!forceBuild) {
            const cachedPath = path.resolve(nodeutil.targetDir, "built", "hexcache", extInfo.sha + ".hex");
            pxt.debug("trying " + cachedPath)
            try {
                const lines = fs.readFileSync(cachedPath, "utf8").split(/\r?\n/)
                pxt.debug(`Using hexcache: ${extInfo.sha}`)
                return Promise.resolve({ hex: lines })
            } catch (e) { }
        }

        if (!forceLocalBuild && (extInfo.onlyPublic || forceCloudBuild))
            return pxt.hexloader.getHexInfoAsync(this, extInfo)

        setBuildEngine()
        return build.buildHexAsync(build.thisBuild, mainPkg, extInfo, forceBuild)
            .then(() => build.thisBuild.patchHexInfo(extInfo))
    }

    cacheStoreAsync(id: string, val: string): Promise<void> {
        mkHomeDirs()
        return writeFileAsync(path.join(cacheDir(), id), val, "utf8")
    }

    cacheGetAsync(id: string): Promise<string> {
        return readFileAsync(path.join(cacheDir(), id), "utf8")
            .then((v: string) => v, (e: any) => null as string)
    }

    downloadPackageAsync(pkg: pxt.Package) {
        return pkg.commonDownloadAsync()
            .then(resp => {
                if (resp) {
                    U.iterMap(resp, (fn: string, cont: string) => {
                        pkg.host().writeFile(pkg, fn, cont)
                    })
                    return Promise.resolve()
                }
                let proto = pkg.verProtocol()
                if (proto == "file") {
                    pxt.debug(`skipping download of local pkg: ${pkg.version()}`)
                    return Promise.resolve()
                } else if (proto == "invalid") {
                    pxt.log(`skipping invalid pkg ${pkg.id}`);
                    return Promise.resolve();
                } else {
                    return Promise.reject(`Cannot download ${pkg.version()}; unknown protocol`)
                }
            })
    }

}

let mainPkg = new pxt.MainPackage(new Host())

function installPackageNameAsync(packageName: string): Promise<void> {
    if (!packageName) return Promise.resolve();

    // builtin?
    if (pxt.appTarget.bundledpkgs[packageName])
        return addDepAsync(packageName, "*", false);

    // github?
    let parsed = pxt.github.parseRepoId(packageName)
    if (parsed && parsed.fullName)
        return loadGithubTokenAsync()
            .then(() => pxt.packagesConfigAsync())
            .then(config => (parsed.tag ? Promise.resolve(parsed.tag) : pxt.github.latestVersionAsync(parsed.fullName, config))
                .then(tag => { parsed.tag = tag })
                .then(() => pxt.github.pkgConfigAsync(parsed.fullName, parsed.tag))
                .then(cfg => mainPkg.loadAsync(true)
                    .then(() => {
                        let ver = pxt.github.stringifyRepo(parsed)
                        return addDepAsync(cfg.name, ver, false);
                    })));
    // shared url?
    let sharedId = pxt.Cloud.parseScriptId(packageName);
    if (sharedId)
        return addDepAsync(sharedId, packageName, false);

    // don't know
    U.userError(lf(`unknown package ${packageName}`))
    return Promise.resolve();
}

export function installAsync(parsed?: commandParser.ParsedCommand): Promise<void> {
    pxt.log("installing dependencies...");
    ensurePkgDir();
    const packageName = parsed && parsed.args.length ? parsed.args[0] : undefined;
    let hwvariant = parsed && parsed.flags["hwvariant"] as string;
    if (hwvariant && !/^hw---/.test(hwvariant))
        hwvariant = 'hw---' + hwvariant;

    return installPackageNameAsync(packageName)
        .then(() => addDepsAsync())
        .then(() => mainPkg.installAllAsync())
        .then(() => {
            let tscfg = "tsconfig.json"
            if (!fs.existsSync(tscfg) && !fs.existsSync("../" + tscfg)) {
                nodeutil.writeFileSync(tscfg, pxt.template.TS_CONFIG)
            }
        });

    function addDepsAsync() {
        return hwvariant ? addDepAsync(hwvariant, "*", true) : Promise.resolve();
    }
}

function addDepAsync(name: string, ver: string, hw: boolean) {
    console.log(U.lf("adding {0}: {1}", name, ver))
    return mainPkg.loadAsync(true)
        .then(() => {
            if (hw) {
                // remove other hw variants
                Object.keys(mainPkg.config.dependencies)
                    .filter(k => /^hw---/.test(k))
                    .forEach(k => delete mainPkg.config.dependencies[k]);
            }
            mainPkg.config.dependencies[name] = ver;
            mainPkg.saveConfig()
            mainPkg = new pxt.MainPackage(new Host())
        })
}

function addFile(name: string, cont: string) {
    let ff = mainPkg.getFiles()
    if (ff.indexOf(name) < 0) {
        mainPkg.config.files.push(name)
        mainPkg.saveConfig()
        console.log(U.lf("Added {0} to files in {1}.", name, pxt.CONFIG_NAME))
    }

    if (!fs.existsSync(name)) {
        let vars: Map<string> = {}
        let cfg = mainPkg.config as any
        for (let k of Object.keys(cfg)) {
            if (typeof cfg[k] == "string")
                vars[k] = cfg
        }
        vars["ns"] = mainPkg.config.name.replace(/[^a-zA-Z0-9]/g, "_")
        cont = cont.replace(/@([a-z]+)@/g, (f, k) => U.lookup(vars, k) || "")
        nodeutil.writeFileSync(name, cont)
    } else {
        console.log(U.lf("Not overwriting {0}.", name))
    }
}


function addAsmAsync() {
    addFile("helpers.asm", `; example helper function
@ns@_helper:
    push {lr}
    adds r0, r0, r1
    pop {pc}
`)

    addFile("helpers.ts",
        `namespace @ns@ {
    /**
     * Help goes here.
     */
    //% shim=@ns@_helper
    export function helper(x: number, y: number) {
        // Dummy implementation for the simulator.
        return x - y
    }
}
`)
    return Promise.resolve()
}

function addCppAsync() {
    addFile("extension.cpp",
        `#include "pxt.h"
using namespace pxt;
namespace @ns@ {
    //%
    int extfun(int x, int y) {
        return x + y;
    }
}
`)
    addFile("extension.ts",
        `namespace @ns@ {
    /**
     * Help goes here.
     */
    //% shim=@ns@::extfun
    export function extfun(x: number, y: number) {
        // Dummy implementation for the simulator.
        return x - y
    }
}
`)

    addFile("shims.d.ts", "// Will be auto-generated if needed.\n")
    addFile("enums.d.ts", "// Will be auto-generated if needed.\n")

    return Promise.resolve()
}

export function addAsync(parsed: commandParser.ParsedCommand) {
    if (pxt.appTarget.compile.hasHex) {
        p.defineCommand({ name: "asm", help: "add assembly support" }, addAsmAsync);
        p.defineCommand({ name: "cpp", help: "add C++ extension support" }, addCppAsync);
    }
    return handleCommandAsync(parsed.args, loadPkgAsync)
}

export function initAsync(parsed: commandParser.ParsedCommand) {
    if (fs.existsSync(pxt.CONFIG_NAME))
        U.userError(`${pxt.CONFIG_NAME} already present`)

    const files = pxt.template.packageFiles(path.basename(path.resolve(".")).replace(/^pxt-/, ""))

    let configMap: Map<string> = JSON.parse(files[pxt.CONFIG_NAME])
    let initPromise = Promise.resolve();
    if (!parsed.flags["useDefaults"]) {
        initPromise = Promise.mapSeries(["name", "description", "license"], f =>
            queryAsync(f, configMap[f])
                .then(r => {
                    configMap[f] = r
                })).then(() => { });
    }

    return initPromise
        .then(() => {
            files[pxt.CONFIG_NAME] = nodeutil.stringify(configMap);

            pxt.template.packageFilesFixup(files)

            U.iterMap(files, (k, v) => {
                nodeutil.mkdirP(path.dirname(k))
                nodeutil.writeFileSync(k, v)
            })
        })
        .then(() => installAsync())
        .then(() => {
            pxt.log("Package initialized.")
            pxt.log("Try 'pxt add' to add optional features.")
        })
}

enum BuildOption {
    JustBuild,
    Run,
    Deploy,
    Test,
    DebugSim,
    GenDocs,
}

export function serviceAsync(parsed: commandParser.ParsedCommand) {
    let fn = "built/response.json"
    return mainPkg.getCompileOptionsAsync()
        .then(opts => {
            pxtc.service.performOperation("reset", {})
            pxtc.service.performOperation("setOpts", { options: opts })
            return pxtc.service.performOperation(parsed.args[0], {})
        })
        .then(res => {
            if (res.errorMessage) {
                console.error("Error calling service:", res.errorMessage)
                process.exit(1)
            } else {
                mainPkg.host().writeFile(mainPkg, fn, nodeutil.stringify(res))
                console.log("wrote results to " + fn)
            }
        })
}

export function augmnetDocsAsync(parsed: commandParser.ParsedCommand) {
    let f0 = fs.readFileSync(parsed.args[0], "utf8")
    let f1 = fs.readFileSync(parsed.args[1], "utf8")
    console.log(pxt.docs.augmentDocs(f0, f1))
    return Promise.resolve()
}

export function timeAsync() {
    ensurePkgDir();
    let min: Map<number[]> = {};
    let t0 = 0, t1 = 0
    let loop = () =>
        Promise.resolve()
            .then(() => {
                t0 = U.cpuUs()
                const opts = mainPkg.getTargetOptions()
                // opts.isNative = true
                return mainPkg.getCompileOptionsAsync(opts)
            })
            .then(copts => {
                t1 = U.cpuUs()
                return pxtc.compile(copts)
            })
            .then(res => {
                res.times["options"] = t1 - t0
                U.iterMap(res.times, (k, v) => {
                    v = Math.round(v / 1000)
                    res.times[k] = v
                    if (!min[k]) min[k] = []
                    min[k].push(v)
                })
                console.log(res.times)
            })
    return Promise.resolve()
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(loop)
        .then(() => {
            U.iterMap(min, (k, v) => {
                v.sort((a, b) => a - b)
            })
            console.log(min)
        })
}

export function exportCppAsync(parsed: commandParser.ParsedCommand) {
    ensurePkgDir();
    return mainPkg.loadAsync()
        .then(() => {
            setBuildEngine();
            let target = mainPkg.getTargetOptions()
            if (target.hasHex)
                target.isNative = true
            target.keepCppFiles = true
            return mainPkg.getCompileOptionsAsync(target)
        })
        .then(opts => {
            for (let s of Object.keys(opts.extinfo.extensionFiles)) {
                let s2 = s.replace("/pxtapp/", "")
                if (s2 == s) continue
                if (s2 == "main.cpp") continue
                const trg = path.join(parsed.args[0], s2)
                nodeutil.mkdirP(path.dirname(trg))
                fs.writeFileSync(trg, opts.extinfo.extensionFiles[s])
            }
        })
}

export function formatAsync(parsed: commandParser.ParsedCommand) {
    let inPlace = !!parsed.flags["i"];
    let testMode = !!parsed.flags["t"];

    let fileList = Promise.resolve()
    let fileNames = parsed.args;
    if (fileNames.length == 0) {
        fileList = mainPkg
            .loadAsync()
            .then(() => {
                fileNames = mainPkg.getFiles().filter(f => U.endsWith(f, ".ts"))
            })
    }

    return fileList
        .then(() => {
            let numErr = 0
            for (let f of fileNames) {
                let input = fs.readFileSync(f, "utf8")
                let tmp = pxtc.format(input, 0)
                let formatted = tmp.formatted
                let expected = testMode && fs.existsSync(f + ".exp") ? fs.readFileSync(f + ".exp", "utf8") : null
                let fn = f + ".new"

                if (testMode) {
                    if (expected == null)
                        expected = input
                    if (formatted != expected) {
                        nodeutil.writeFileSync(fn, formatted, { encoding: "utf8" })
                        console.log("format test FAILED; written:", fn)
                        numErr++;
                    } else {
                        fs.unlink(fn, err => { })
                        console.log("format test OK:", f)
                    }
                } else if (formatted == input) {
                    console.log("already formatted:", f)
                    if (!inPlace)
                        fs.unlink(fn, err => { })
                } else if (inPlace) {
                    nodeutil.writeFileSync(f, formatted, { encoding: "utf8" })
                    console.log("replaced:", f)
                } else {
                    nodeutil.writeFileSync(fn, formatted, { encoding: "utf8" })
                    console.log("written:", fn)
                }

            }

            if (numErr) {
                console.log(`${numErr} formatting test(s) FAILED.`)
                process.exit(1)
            } else {
                console.log(`${fileNames.length} formatting test(s) OK`)
            }
        })
}

function runCoreAsync(res: pxtc.CompileResult) {
    let f = res.outfiles[pxtc.BINARY_JS]
    if (f) {
        pxsim.initCurrentRuntime = pxsim.initBareRuntime
        let r = new pxsim.Runtime({
            type: "run",
            code: f
        })
        pxsim.Runtime.messagePosted = (msg) => {
            switch (msg.type) {
                case "serial":
                    {
                        const m = <pxsim.SimulatorSerialMessage>msg;
                        let d = m.data;
                        if (typeof d == "string") d = d.replace(/\n$/, "")
                        console.log("serial: ", d);
                    }
                    break;
                case "bulkserial":
                    {
                        const m = <pxsim.SimulatorBulkSerialMessage>msg;
                        let d = m.data;
                        if (Array.isArray(d)) {
                            d.forEach(datum => {
                                if (typeof datum.data == "string") datum.data = datum.data.replace(/\n$/, "")
                                console.log("serial: ", datum.data);
                            })
                        }
                    }
                    break;
                case "i2c":
                    {
                        const m = <pxsim.SimulatorI2CMessage>msg;
                        let d = m.data;
                        if (d)
                            console.log(`i2c: ${d}`);
                    }
                    break;
                default:
                    {
                        const m = <pxsim.SimulatorMessage>msg;
                        console.log(`${m.type}: ${JSON.stringify(m)}`);
                    }
                    break;
            }
        }
        r.errorHandler = (e) => {
            throw e;
        }
        r.run(() => {
            console.log("-- done")
            pxsim.dumpLivePointers();
        })
    }
    return Promise.resolve()
}

function simulatorCoverage(pkgCompileRes: pxtc.CompileResult, pkgOpts: pxtc.CompileOptions) {
    process.chdir("../..")
    if (!nodeutil.existsDirSync(simDir())) return;

    let decls: Map<ts.Symbol> = {}

    if (!pkgOpts.extinfo || pkgOpts.extinfo.functions.length == 0) return

    pxt.debug("checking for missing sim implementations...")

    const sources = ["built/sim.d.ts", "node_modules/pxt-core/built/pxtsim.d.ts"];
    if (fs.existsSync("built/common-sim.d.ts")) {
        sources.push("built/common-sim.d.ts")
    }

    if (!fs.existsSync(sources[0]))
        return // simulator not yet built; will try next time

    let opts: pxtc.CompileOptions = {
        fileSystem: {},
        sourceFiles: sources,
        target: mainPkg.getTargetOptions(),
        ast: true,
        noEmit: true
    }

    opts.target.isNative = false

    for (let fn of opts.sourceFiles) {
        opts.fileSystem[fn] = fs.readFileSync(path.join(nodeutil.targetDir, fn), "utf8")
    }

    let simDeclRes = pxtc.compile(opts)

    // The program we compiled was missing files, so filter out those errors
    reportDiagnostics(simDeclRes.diagnostics.filter(d => d.code != 5012 /* file not found */ && d.code != 2318/* missing global type */));

    let typechecker = simDeclRes.ast.getTypeChecker()
    let doSymbol = (sym: ts.Symbol) => {
        if (sym.getFlags() & ts.SymbolFlags.HasExports) {
            typechecker.getExportsOfModule(sym).forEach(doSymbol)
        }
        decls[pxtc.getFullName(typechecker, sym)] = sym
    }
    let doStmt = (stmt: ts.Statement) => {
        let mod = stmt as ts.ModuleDeclaration
        if (mod.name) {
            let sym = typechecker.getSymbolAtLocation(mod.name)
            if (sym) doSymbol(sym)
        }
    }
    for (let sf of simDeclRes.ast.getSourceFiles()) {
        sf.statements.forEach(doStmt)
    }

    for (let info of pkgOpts.extinfo.functions) {
        let shim = info.name
        if (pxtc.isBuiltinSimOp(shim))
            continue
        let simName = pxtc.shimToJs(shim)
        let sym = U.lookup(decls, simName)
        if (!sym) {
            pxt.log("missing in sim: " + simName)
        }
    }

    /*
    let apiInfo = pxtc.getApiInfo(pkgCompileRes.ast)
    for (let ent of U.values(apiInfo.byQName)) {
        let shim = ent.attributes.shim
        if (shim) {
            let simName = pxtc.shimToJs(shim)
            let sym = U.lookup(decls, simName)
            if (!sym) {
                console.log("missing in sim:", simName)
            }
        }
    }
    */
}

function testAssemblers(): Promise<void> {
    console.log("- testing Thumb")
    let thumb = new pxtc.thumb.ThumbProcessor();
    thumb.testAssembler();
    console.log("- done testing Thumb");
    return Promise.resolve();
}


function testForBuildTargetAsync(useNative: boolean, cachedSHA: string): Promise<TargetPackageInfo> {
    let opts: pxtc.CompileOptions
    let api: pxtc.ApisInfo;

    let sha: string;

    return mainPkg.loadAsync()
        .then(() => {
            copyCommonFiles();
            setBuildEngine();
            let target = mainPkg.getTargetOptions()
            if (target.hasHex)
                target.isNative = true
            if (!useNative)
                target.isNative = false
            return mainPkg.getCompileOptionsAsync(target)
        })
        .then(o => {
            opts = o
            opts.testMode = true
            opts.ast = true

            sha = pxtc.U.sha256(JSON.stringify(opts.fileSystem) + pxt.appTarget.versions.pxt);
            if (useNative)
                return pxtc.compile(opts)
            else {
                pxt.debug("  skip native build of non-project")

                if (cachedSHA !== sha && !pxt.appTarget.appTheme.disableAPICache) {
                    pxt.log(`Updating cached API info for ${opts.name}`);
                    const res = pxtc.compile(opts);
                    api = pxtc.getApiInfo(res.ast, opts.jres);
                }
                return null
            }
        })
        .then(res => {
            if (res) {
                reportDiagnostics(res.diagnostics);
                if (!res.success) U.userError("Compiler test failed")
                simulatorCoverage(res, opts)

                if (cachedSHA !== sha && !pxt.appTarget.appTheme.disableAPICache) {
                    pxt.log(`Updating cached API info for ${opts.name}`);
                    api = pxtc.getApiInfo(res.ast, opts.jres);
                }
            }
        })
        .then(() => ({ options: opts, api: api, sha }));
}

function simshimAsync() {
    pxt.debug("looking for shim annotations in the simulator.")
    if (!fs.existsSync(path.join(simDir(), "tsconfig.json"))) {
        pxt.debug("no sim/tsconfig.json; skipping")
        return Promise.resolve();
    }
    let prog = pxtc.plainTscCompileDir(path.resolve(simDir()))
    let shims = pxt.simshim(prog, path.parse)
    let filename = "sims.d.ts"
    for (const s of Object.keys(shims)) {
        let cont = shims[s]
        if (!cont.trim()) continue
        cont = "// Auto-generated from simulator. Do not edit.\n" + cont +
            "\n// Auto-generated. Do not edit. Really.\n"
        let cfgname = "libs/" + s + "/" + pxt.CONFIG_NAME
        let cfg = nodeutil.readPkgConfig("libs/" + s)
        if (cfg.files.indexOf(filename) == -1) {
            if (pxt.appTarget.variants)
                return Promise.resolve() // this is fine - there are native variants that generate shims
            U.userError(U.lf("please add \"{0}\" to {1}", filename, cfgname))
        }
        let fn = "libs/" + s + "/" + filename
        if (fs.readFileSync(fn, "utf8") != cont) {
            pxt.debug(`updating ${fn}`)
            nodeutil.writeFileSync(fn, cont)
        }
    }
    return Promise.resolve()
}

function copyCommonFiles() {
    for (let f of mainPkg.getFiles()) {
        if (U.lookup(commonfiles, f)) {
            mainPkg.host().writeFile(mainPkg, "built/" + f, commonfiles[f])
        }
    }
}

function getCachedAsync(url: string, path: string) {
    return (readFileAsync(path, "utf8") as Promise<string>)
        .then(v => v, (e: any) => {
            //console.log(`^^^ fetch ${id} ${Date.now() - start}ms`)
            return null
        })
        .then<string>(v => v ? Promise.resolve(v) :
            U.httpGetTextAsync(url)
                .then(v => writeFileAsync(path, v)
                    .then(() => v)))
}

function patchOpts(opts: pxtc.CompileOptions, fn: string, content: string) {
    console.log(`*** ${fn}, size=${content.length}`)
    let opts2 = U.flatClone(opts)
    opts2.fileSystem = U.flatClone(opts.fileSystem)
    opts2.sourceFiles = opts.sourceFiles.slice()
    opts2.sourceFiles.push(fn)
    opts2.fileSystem[fn] = content
    opts2.embedBlob = null
    opts2.embedMeta = null
    return opts2
}

function compilesOK(opts: pxtc.CompileOptions, fn: string, content: string) {
    let opts2 = patchOpts(opts, fn, content)
    let res = pxtc.compile(opts2)
    reportDiagnostics(res.diagnostics);
    if (!res.success) {
        console.log("ERRORS", fn)
    }
    return res.success
}

function getApiInfoAsync() {
    return prepBuildOptionsAsync(BuildOption.GenDocs)
        .then(opts => {
            let res = pxtc.compile(opts);
            return pxtc.getApiInfo(res.ast, opts.jres, true)
        })
}

function findTestFile() {
    let tsFiles = mainPkg.getFiles().filter(fn => U.endsWith(fn, ".ts"))
    if (tsFiles.length != 1)
        U.userError("need exactly one .ts file in package to 'testdir'")
    return tsFiles[0]
}

function prepTestOptionsAsync() {
    return prepBuildOptionsAsync(BuildOption.Test)
        .then(opts => {
            let tsFile = findTestFile()
            delete opts.fileSystem[tsFile]
            opts.sourceFiles = opts.sourceFiles.filter(f => f != tsFile)
            return opts
        })
}

interface TestInfo {
    filename: string;
    base: string;
    text: string;
}

function testDirAsync(parsed: commandParser.ParsedCommand) {
    forceCloudBuild = true;

    const dir = path.resolve(parsed.args[0] || ".");
    let tests: TestInfo[] = []
    let outdir = dir + "/built/"

    nodeutil.mkdirP(outdir)

    for (let fn of fs.readdirSync(dir)) {
        if (fn[0] == ".") continue;
        let full = dir + "/" + fn
        if (U.endsWith(fn, ".ts")) {
            let text = fs.readFileSync(full, "utf8")
            let m = /^\s*\/\/\s*base:\s*(\S+)/m.exec(text)
            let base = m ? m[1] : "base"
            tests.push({
                filename: full,
                base: base,
                text: text
            })
        } else if (fs.existsSync(full + "/" + pxt.CONFIG_NAME)) {
            tests.push({
                filename: full,
                base: fn,
                text: null
            })
        }
    }

    tests.sort((a, b) => {
        let r = U.strcmp(a.base, b.base)
        if (r == 0)
            if (a.text == null) return -1
            else if (b.text == null) return 1
            else return U.strcmp(a.filename, b.filename)
        else return r
    })

    let currBase = ""
    let errors: string[] = []

    return Promise.mapSeries(tests, (ti) => {
        let fn = path.basename(ti.filename)
        console.log(`--- ${fn}`)
        let hexPath = outdir + fn.replace(/\.ts$/, "") + ".hex"
        if (ti.text == null) {
            currBase = ti.base
            process.chdir(ti.filename)
            mainPkg = new pxt.MainPackage(new Host())
            return installAsync()
                .then(testAsync)
                .then(() => {
                    if (pxt.appTarget.compile.hasHex)
                        nodeutil.writeFileSync(hexPath, fs.readFileSync(`built/binary.${pxt.appTarget.compile.useUF2 ? "uf2" : "hex"}`))
                })
        } else {
            let start = Date.now()
            if (currBase != ti.base) {
                throw U.userError("Base directory: " + ti.base + " not found.")
            } else {
                let tsf = findTestFile()
                let files = mainPkg.config.files
                let idx = files.indexOf(tsf)
                U.assert(idx >= 0)
                files[idx] = fn
                mainPkg.config.name = fn.replace(/\.ts$/, "")
                mainPkg.config.description = `Generated from ${ti.base} with ${fn}`
                const host = mainPkg.host() as Host;
                host.fileOverrides = {}
                host.fileOverrides[fn] = ti.text
                return prepBuildOptionsAsync(BuildOption.Test, true)
                    .then(opts => {
                        let res = pxtc.compile(opts)
                        let lines = ti.text.split(/\r?\n/)
                        let errCode = (s: string) => {
                            if (!s) return 0
                            let m = /\/\/\s*TS(\d\d\d\d\d?)/.exec(s)
                            if (m) return parseInt(m[1])
                            else return 0
                        }
                        let numErr = 0
                        for (let diag of res.diagnostics) {
                            if (!errCode(lines[diag.line])) {
                                reportDiagnostics(res.diagnostics);
                                numErr++
                            }
                        }
                        let lineNo = 0
                        for (let line of lines) {
                            let code = errCode(line)
                            if (code && res.diagnostics.filter(d => d.line == lineNo && d.code == code).length == 0) {
                                numErr++
                                console.log(`${fn}(${lineNo + 1}): expecting error TS${code}`)
                            }
                            lineNo++
                        }
                        if (numErr) {
                            console.log("ERRORS", fn)
                            errors.push(fn)
                            fs.unlink(hexPath, (err) => { }) // ignore errors
                        } else {
                            let hex = res.outfiles["binary.hex"]
                            if (hex) {
                                nodeutil.writeFileSync(hexPath, hex)
                                console.log(`wrote hex: ${hexPath} ${hex.length} bytes; ${Date.now() - start}ms`)
                            }
                        }
                    })
            }
        }
    })
        .then(() => {
            if (errors.length) {
                console.log("Errors: " + errors.join(", "))
                process.exit(1)
            } else {
                console.log("All OK.")
            }
        })
}

function replaceFileExtension(file: string, extension: string) {
    return file && file.substr(0, file.length - path.extname(file).length) + extension;
}

interface PackageConflictTestCase {
    id: number
    dependencies: string[];
    pkgToAdd: string;
    main: string;
    expectedConflicts: string[];
    expectedInUse: string[];
}

function testPkgConflictsAsync() {
    console.log("Package conflict tests");
    /*
    Fake bundled packages are as follows (see [pxt root]/tests/pkgconflicts/built/target.json):
        Project dependencies        Packages added by test cases, conflicts in parentheses
        A  B  C                     F(C)  G     H(C,D)      G has "configIsJustDefaults"
        | / \                       |     |     |           I has same setting values as installed dependencies
        D    E                      I     J(D)  K(C,E)
    */
    const testCases: PackageConflictTestCase[] = [
        { id: 1, dependencies: ["A", "B", "C"], pkgToAdd: "I", main: "D.test()", expectedConflicts: [], expectedInUse: [] },
        { id: 2, dependencies: ["A", "B"], pkgToAdd: "F", main: "test.test()", expectedConflicts: [], expectedInUse: [] },
        { id: 3, dependencies: ["B", "C"], pkgToAdd: "J", main: "C.test()", expectedConflicts: ["B", "D"], expectedInUse: [] },
        { id: 4, dependencies: ["A", "B", "C"], pkgToAdd: "G", main: "D.test()\nC.test()", expectedConflicts: ["A", "B", "D"], expectedInUse: ["D"] },
        { id: 5, dependencies: ["A", "B", "C"], pkgToAdd: "H", main: "C.test()\nD.test()\ntest.test()\E.test()", expectedConflicts: ["A", "B", "C", "D", "E"], expectedInUse: ["C", "D", "E"] },
        { id: 6, dependencies: ["A", "B", "C"], pkgToAdd: "F", main: "", expectedConflicts: ["C"], expectedInUse: [] },
    ];
    const failures: { testCase: number; reason: string }[] = [];
    const oldAppTarget = pxt.appTarget;

    nodeutil.setTargetDir(path.join(__dirname, "..", "tests", "pkgconflicts"));
    let trg = nodeutil.getPxtTarget();
    pxt.setAppTarget(trg);

    return Promise.mapSeries(testCases, (tc) => {
        let testFailed = (reason: string) => {
            failures.push({ testCase: tc.id, reason });
        };

        const dep: pxt.Map<string> = {};
        tc.dependencies.forEach(d => dep[d] = "*");
        let mainPkg = new pxt.MainPackage(new SnippetHost("package conflict tests", { "main.ts": tc.main }, dep));
        tc.expectedConflicts = tc.expectedConflicts.sort();
        tc.expectedInUse = tc.expectedInUse.sort();

        return mainPkg.installAllAsync()
            .then(() => mainPkg.findConflictsAsync(tc.pkgToAdd, "*"))
            .then((conflicts) => {
                let conflictNames = conflicts.map((c) => c.pkg0.id).sort();
                if (conflictNames.length !== tc.expectedConflicts.length || !conflictNames.every((cn, i) => conflictNames[i] === tc.expectedConflicts[i])) {
                    testFailed(`Mismatch on expected conflicts (found: [${conflictNames.join(", ")}], expected: [${tc.expectedConflicts.join(", ")}])`);
                } else {
                    let inUse = conflictNames.filter((cn) => mainPkg.isPackageInUse(cn));
                    if (inUse.length !== tc.expectedInUse.length || !inUse.every((cn, i) => inUse[i] === tc.expectedInUse[i])) {
                        testFailed(`Mismatch on expected in-use conflicts (found: [${inUse.join(", ")}], expected: [${tc.expectedInUse.join(", ")}])`);
                    }
                }

                pxt.log(`package conflict test OK: ${tc.id}`);
                return Promise.resolve();
            })
            .catch((e) => {
                pxt.log(`package conflict test FAILED: ${tc.id}`);
                testFailed("Uncaught exception during test: " + e.message || e);
            });
    })
        .then(() => {
            pxt.log(`${testCases.length - failures.length} passed, ${failures.length} failed`);

            if (failures.length) {
                pxt.log(failures.map((e) => `Failure in test case ${e.testCase}: ${e.reason}`).join("\n"));
                process.exit(1);
            }
        })
        .finally(() => {
            pxt.setAppTarget(oldAppTarget);
        });
}

function decompileAsync(parsed: commandParser.ParsedCommand) {
    return Promise.mapSeries(parsed.args, f => {
        const outFile = replaceFileExtension(f, ".blocks")
        return decompileAsyncWorker(f, parsed.flags["dep"] as string)
            .then(result => {
                nodeutil.writeFileSync(outFile, result)
            })
    })
        .then(() => {
            console.log("Done")
        }, error => {
            console.log("Error: " + error)
        })
}

function decompileAsyncWorker(f: string, dependency?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const input = fs.readFileSync(f, "utf8")
        const dep: pxt.Map<string> = {};
        if (dependency)
            dep[dependency] = "*";
        let inPackages = { "main.ts": input, "main.py": "" }
        const pkg = new pxt.MainPackage(new SnippetHost("decompile-pkg", inPackages, dep, true));

        pkg.installAllAsync()
            .then(() => pkg.getCompileOptionsAsync())
            .then(opts => {
                opts.ast = true;
                const decompiled = pxtc.decompile(pxtc.getTSProgram(opts), opts, "main.ts");
                if (decompiled.success) {
                    resolve(decompiled.outfiles["main.blocks"]);
                }
                else {
                    reject("Could not decompile " + f + JSON.stringify(decompiled.diagnostics, null, 4));
                }
            });
    });
}

function testSnippetsAsync(snippets: CodeSnippet[], re?: string, pyStrictSyntaxCheck?: boolean): Promise<void> {
    console.log(`### TESTING ${snippets.length} CodeSnippets`)
    pxt.github.forceProxy = true; // avoid throttling in CI machines
    let filenameMatch: RegExp;
    try {
        let pattern = re || '.*';
        filenameMatch = new RegExp(pattern);
    }
    catch (e) {
        pxt.log(`pattern could not be compiled as a regular expression, ignoring`);
        filenameMatch = new RegExp('.*')
    }
    snippets = snippets.filter(snippet => filenameMatch.test(snippet.name));
    let ignoreCount = 0
    const cache: pxt.Map<string> = {};
    const successes: string[] = []
    interface FailureInfo {
        filename: string
        diagnostics: pxtc.KsDiagnostic[]
    }
    const failures: FailureInfo[] = []
    const addSuccess = (s: string) => {
        successes.push(s)
    }
    const addFailure = (f: string, infos: pxtc.KsDiagnostic[]) => {
        failures.push({
            filename: f,
            diagnostics: infos
        })
        infos.forEach(info => pxt.log(`${f}:(${info.line},${info.column}): ${info.category} ${info.messageText}`));
    }
    return Promise.map(snippets, (snippet: CodeSnippet) => {
        const name = snippet.name;
        const fn = snippet.file || snippet.name;
        pxt.log(`  ${fn} (${snippet.type})`);

        if (snippet.ext == "json") {
            try {
                const codecards = JSON.parse(snippet.code)
                if (!codecards || !Array.isArray(codecards))
                    throw new Error("codecards must be an JSON array")
                addSuccess(fn);
            } catch (e) {
                addFailure(fn, [{
                    code: 4242,
                    category: ts.DiagnosticCategory.Error,
                    messageText: "invalid JSON: " + e.message,
                    fileName: fn,
                    start: 1,
                    line: 1,
                    length: 1,
                    column: 1
                }]);
            }
            return Promise.resolve();
        }

        let isPy = snippet.ext === "py"
        let inFiles;
        if (isPy)
            inFiles = { "main.ts": "", "main.py": snippet.code, "main.blocks": "" }
        else
            inFiles = { "main.ts": snippet.code, "main.py": "", "main.blocks": "" }
        const host = new SnippetHost("snippet" + name, inFiles, snippet.packages);
        host.cache = cache;
        const pkg = new pxt.MainPackage(host);
        return pkg.installAllAsync()
            .then(() => pkg.getCompileOptionsAsync().then(opts => {
                opts.ast = true
                let resp: { outfiles: Map<string>, success: boolean, diagnostics: pxtc.KsDiagnostic[], ast?: ts.Program };
                if (isPy) {
                    opts.target.preferredEditor = pxt.JAVASCRIPT_PROJECT_NAME
                    const stsCompRes = pxtc.compile(opts);
                    const apisInfo = pxtc.getApiInfo(stsCompRes.ast, opts.jres)
                    if (!apisInfo || !apisInfo.byQName)
                        throw Error("Failed to get apisInfo")
                    opts.apisInfo = apisInfo

                    opts.target.preferredEditor = pxt.PYTHON_PROJECT_NAME

                    const { outfiles, diagnostics } = pxt.py.py2ts(opts)
                    const success = diagnostics.length == 0
                    resp = { outfiles, success, diagnostics, ast: stsCompRes.ast }
                } else {
                    resp = pxtc.compile(opts)
                }

                if (resp.outfiles && snippet.file) {
                    const dir = snippet.file
                        .replace(/\.ts$/, '')
                        .replace(/\.py$/, '');
                    nodeutil.mkdirP(dir);
                    nodeutil.mkdirP(path.join(dir, "built"));
                    Object.keys(resp.outfiles).forEach(outfile => {
                        const ofn = path.join(dir, "built", outfile);
                        pxt.debug(`writing ${ofn}`);
                        nodeutil.writeFileSync(ofn, resp.outfiles[outfile], 'utf8')
                    })
                    pkg.filesToBePublishedAsync()
                        .then(files => {
                            Object.keys(files).forEach(f => {
                                const fn = path.join(dir, f);
                                pxt.debug(`writing ${fn}`);
                                nodeutil.writeFileSync(fn, files[f], 'utf8');
                            })
                        })
                }
                if (resp.success) {
                    if (/^block/.test(snippet.type)) {
                        //Similar to pxtc.decompile but allows us to get blocksInfo for round trip
                        const file = resp.ast.getSourceFile('main.ts');
                        const apis = pxtc.getApiInfo(resp.ast, opts.jres);
                        opts.apisInfo = apis

                        // ensure decompile to blocks works
                        const blocksInfo = pxtc.getBlocksInfo(apis);
                        const bresp = pxtc.decompiler.decompileToBlocks(blocksInfo, file, {
                            snippetMode: false,
                            errorOnGreyBlocks: true
                        });
                        let blockSucces = !!bresp.outfiles['main.blocks']
                        if (!blockSucces) {
                            return addFailure(fn, bresp.diagnostics)
                        }

                        // decompile to python
                        let ts1 = opts.fileSystem["main.ts"]
                        let program = pxtc.getTSProgram(opts);
                        const decompiled = pxt.py.decompileToPython(program, "main.ts");
                        let pySuccess = !!decompiled.outfiles['main.py'] && decompiled.success
                        if (!pySuccess) {
                            console.log("ts2py error")
                            return addFailure(fn, decompiled.diagnostics)
                        }
                        opts.fileSystem['main.py'] = decompiled.outfiles['main.py']
                        let py = decompiled.outfiles['main.py']

                        // py to ts
                        opts.target.preferredEditor = pxt.PYTHON_PROJECT_NAME
                        let ts2Res = pxt.py.py2ts(opts)

                        let ts2 = ts2Res.outfiles["main.ts"];

                        if (!ts2) {
                            console.log("py2ts error!")
                            console.dir(ts2Res)
                            let errs = ts2Res.diagnostics.map(pxtc.getDiagnosticString).join()
                            if (errs)
                                console.log(errs)
                            return addFailure(fn, ts2Res.diagnostics)
                        }

                        let getComparisonString = (s: string): string =>
                            s.split("\n")
                                // ignore function names
                                // e.g. function foobar() {}
                                //   => function () {}
                                .map(l => {
                                    let m: RegExpExecArray;
                                    do {
                                        m = /function(.+)\(/.exec(l)
                                        if (m && m.length > 1) {
                                            l = l.replace(`function${m[1]}`, "function")
                                        }
                                    } while (m && m.length > 1)
                                    return l
                                })
                                // ignore type annotations on assignment statements (these tend to get erased)
                                // e.g. let foo: number = 7
                                //   => let foo = 7
                                .map(l => {
                                    let m: RegExpExecArray;
                                    do {
                                        m = /.+:(.+)[=,)]/.exec(l)
                                        if (m && m.length > 1) {
                                            l = l.replace(`:${m[1]}`, "")
                                        }
                                    } while (m && m.length > 1)
                                    return l
                                })
                                // ignore whitespace
                                .map(l => l.replace(/\s/g, ""))
                                // ignore linebreak differences
                                .map(l => l.replace(/\n/g, ""))
                                // ignore semi-colons
                                .map(l => l.replace(/\;/g, ""))
                                // ignore blank lines
                                .filter(l => l)
                                .join("")

                        if (pyStrictSyntaxCheck) {
                            let cmp1 = getComparisonString(ts1)
                            let cmp2 = getComparisonString(ts2)
                            let mismatch = cmp1 != cmp2
                            if (mismatch) {
                                console.log(`Mismatch. Original:`)
                                console.log(cmp1)
                                console.log("decompiled->compiled:")
                                console.log(cmp2)
                                console.log("TS mismatch :/")
                                // TODO: generate more helpful diags
                                return addFailure(fn, [])
                            } else {
                                console.log("TS same :)")
                            }
                        }

                        // NOTE: neither of these decompile steps checks that the resulting code is correct or that
                        // when the code is compiled back to ts it'll behave the same. This could be validated in
                        // the future.

                        return addSuccess(name)
                    }
                    else {
                        return addSuccess(fn)
                    }
                }
                else {
                    return addFailure(name, resp.diagnostics)
                }
            }).catch((e: Error) => {
                addFailure(name, [
                    {
                        code: 4242,
                        category: ts.DiagnosticCategory.Error,
                        messageText: e.message,
                        fileName: fn,
                        start: 1,
                        line: 1,
                        length: 1,
                        column: 1
                    }
                ])
            }))
    }, { concurrency: 1 }).then((a: any) => {
        pxt.log(`${successes.length}/${successes.length + failures.length} snippets compiled to blocks and python (and back), ${failures.length} failed`)
        if (ignoreCount > 0) {
            pxt.log(`Skipped ${ignoreCount} snippets`)
        }
    }).then(() => {
        if (failures.length > 0) {
            const msg = `${failures.length} snippets not compiling in the docs`;
            if (pxt.appTarget.ignoreDocsErrors) pxt.log(msg);
            else U.userError(msg);
        }
    })
}

function setBuildEngine() {
    const cs = pxt.appTarget.compileService
    if (cs && cs.buildEngine) {
        build.setThisBuild(build.buildEngines[cs.buildEngine]);
        if (!build.thisBuild)
            U.userError("cannot find build engine: " + cs.buildEngine)
    }
}

function prepBuildOptionsAsync(mode: BuildOption, quick = false, ignoreTests = false) {
    ensurePkgDir();
    mainPkg.ignoreTests = ignoreTests;
    return mainPkg.loadAsync()
        .then(() => {
            if (!quick) {
                build.buildDalConst(build.thisBuild, mainPkg);
                copyCommonFiles();
                setBuildEngine();
            }
            // TODO pass down 'quick' to disable the C++ extension work
            let target = mainPkg.getTargetOptions()
            if (target.hasHex)
                target.isNative = true
            switch (mode) {
                case BuildOption.Run:
                case BuildOption.DebugSim:
                case BuildOption.GenDocs:
                    target.isNative = false
                    break
                default:
                    break
            }
            return mainPkg.getCompileOptionsAsync(target)
        })
        .then(opts => {
            if (mode == BuildOption.Test)
                opts.testMode = true
            if (mode == BuildOption.GenDocs)
                opts.ast = true

            if (pxt.appTarget.compile.postProcessSymbols && (mode == BuildOption.Deploy || mode == BuildOption.JustBuild)) {
                opts.computeUsedSymbols = true
                opts.ast = true
            }

            if (opts.target.preferredEditor == pxt.PYTHON_PROJECT_NAME) {
                pxt.log("pre-compiling apisInfo for Python")
                pxt.prepPythonOptions(opts)
                if (process.env["PXT_SAVE_APISINFO"])
                    fs.writeFileSync("built/apisinfo.json", nodeutil.stringify(opts.apisInfo))
                pxt.log("done pre-compiling apisInfo for Python")
            }

            return opts;
        })
}

function dbgTestAsync() {
    return buildCoreAsync({
        mode: BuildOption.JustBuild,
        debug: true
    })
        .then(clidbg.startAsync)
}

interface BuildCoreOptions {
    mode: BuildOption;

    debug?: boolean;
    warnDiv?: boolean;
    ignoreTests?: boolean;

    // docs
    locs?: boolean;
    docs?: boolean;
    fileFilter?: string;
    createOnly?: boolean;
}

function gdbAsync(c: commandParser.ParsedCommand) {
    ensurePkgDir()
    setBuildEngine();
    return mainPkg.loadAsync()
        .then(() => gdb.startAsync(c.args))
}

function hwAsync(c: commandParser.ParsedCommand) {
    ensurePkgDir()
    return mainPkg.loadAsync()
        .then(() => gdb.hwAsync(c.args))
}

function dumplogAsync(c: commandParser.ParsedCommand) {
    ensurePkgDir()
    return mainPkg.loadAsync()
        .then(() => gdb.dumplogAsync())
}

function dumpheapAsync(c: commandParser.ParsedCommand) {
    ensurePkgDir()
    return mainPkg.loadAsync()
        .then(() => gdb.dumpheapAsync(c.args[0]))
}

function dumpmemAsync(c: commandParser.ParsedCommand) {
    ensurePkgDir()
    return mainPkg.loadAsync()
        .then(() => gdb.dumpMemAsync(c.args[0]))
}

async function buildDalDTSAsync(c: commandParser.ParsedCommand) {
    forceLocalBuild = true;
    forceBuild = true; // make sure we actually build
    forceCloudBuild = false;
    const clean = !!c.flags["clean"];

    function prepAsync() {
        let p = Promise.resolve();
        if (clean)
            p = p.then(() => cleanAsync())

        p = p.then(() => buildCoreAsync({ mode: BuildOption.JustBuild }))
            .then(() => { });
        return p;
    }

    if (fs.existsSync("pxtarget.json")) {
        pxt.log(`generating dal.d.ts for packages`)
        return rebundleAsync()
            .then(() => forEachBundledPkgAsync((f, dir) => {
                return f.loadAsync()
                    .then(() => {
                        if (f.config.dalDTS && f.config.dalDTS.corePackage) {
                            console.log(`  ${dir}`)
                            return prepAsync()
                                .then(() => build.buildDalConst(build.thisBuild, f, true, true));
                        }
                        return Promise.resolve();
                    })
            }));
    } else {
        ensurePkgDir()
        await mainPkg.loadAsync()
        setBuildEngine();
        build.buildDalConst(build.thisBuild, mainPkg, true, true)
        await prepAsync()
        build.buildDalConst(build.thisBuild, mainPkg, true, true)
    }
}

function buildCoreAsync(buildOpts: BuildCoreOptions): Promise<pxtc.CompileResult> {
    let compileOptions: pxtc.CompileOptions;
    let compileResult: pxtc.CompileResult;
    ensurePkgDir();
    pxt.log(`building ${process.cwd()}`)
    const config = nodeutil.readPkgConfig(process.cwd());
    return prepBuildOptionsAsync(buildOpts.mode, false, buildOpts.ignoreTests)
        .then((opts) => {
            compileOptions = opts;
            if (buildOpts.warnDiv) {
                pxt.debug(`warning on division operators`);
                opts.warnDiv = true;
            }
            opts.breakpoints = buildOpts.mode === BuildOption.DebugSim;
            if (buildOpts.debug) {
                opts.breakpoints = true
                opts.justMyCode = true
            }
            return pxtc.compile(opts);
        })
        .then((res): Promise<void | pxtc.CompileOptions> => {
            compileResult = res
            U.iterMap(res.outfiles, (fn, c) => {
                if (fn !== pxtc.BINARY_JS) {
                    mainPkg.host().writeFile(mainPkg, "built/" + fn, c);
                    pxt.debug(`package written to ${"built/" + fn}`);
                }
                else {
                    mainPkg.host().writeFile(mainPkg, "built/debug/" + fn, c);
                    pxt.debug(`package written to ${"built/debug/" + fn}`);
                }
            });

            const shouldExit = !res.success && buildOpts.mode != BuildOption.GenDocs
            if (shouldExit || !config.partial)
                reportDiagnostics(res.diagnostics);
            if (shouldExit) {
                process.exit(1)
            }

            if (buildOpts.mode === BuildOption.DebugSim) {
                mainPkg.host().writeFile(mainPkg, "built/debug/debugInfo.json", JSON.stringify({
                    usedParts: pxtc.computeUsedParts(res, true),
                    usedArguments: res.usedArguments,
                    breakpoints: res.breakpoints
                }));
            }

            if (res.usedSymbols && compileOptions.computeUsedSymbols) {
                const apiInfo = pxtc.getApiInfo(res.ast, compileOptions.jres)
                for (let k of Object.keys(res.usedSymbols)) {
                    res.usedSymbols[k] = apiInfo.byQName[k] || null
                }
            }

            if (pxt.appTarget.compile.switches.time)
                console.log(compileResult.times)

            switch (buildOpts.mode) {
                case BuildOption.GenDocs:
                    const apiInfo = pxtc.getApiInfo(res.ast, compileOptions.jres)
                    // keeps apis from this module only
                    for (const infok in apiInfo.byQName) {
                        const info = apiInfo.byQName[infok];
                        if (info.pkg &&
                            info.pkg != mainPkg.config.name) delete apiInfo.byQName[infok];
                    }
                    // Look for and read pxt snippets file
                    const pxtsnippet = pxt.Util.jsonTryParse(mainPkg.readFile('pxtsnippets.json')) as pxt.SnippetConfig[];
                    pxt.debug(`generating api docs (${Object.keys(apiInfo.byQName).length})`);
                    const md = pxtc.genDocs(mainPkg.config.name, apiInfo, {
                        package: mainPkg.config.name != pxt.appTarget.corepkg && !mainPkg.config.core,
                        locs: buildOpts.locs,
                        docs: buildOpts.docs,
                        pxtsnippet: pxtsnippet,
                    })
                    if (buildOpts.fileFilter) {
                        const filterRx = new RegExp(buildOpts.fileFilter, "i");
                        Object.keys(md).filter(fn => !filterRx.test(fn)).forEach(fn => delete md[fn]);
                    }
                    for (const fn in md) {
                        const folder = /strings.json$/.test(fn) ? "_locales/" : /\.md$/.test(fn) ? "../../docs/" : "built/";
                        const ffn = path.join(folder, fn);
                        if (!buildOpts.createOnly || !fs.existsSync(ffn)) {
                            nodeutil.mkdirP(path.dirname(ffn));
                            mainPkg.host().writeFile(mainPkg, ffn, md[fn])
                            pxt.debug(`generated ${ffn}; size=${md[fn].length}`)
                        }
                    }
                    return null
                case BuildOption.Deploy:
                    if (pxt.commands.hasDeployFn())
                        return pxt.commands.deployAsync(res)
                    else {
                        pxt.log("no deploy functionality defined by this target")
                        return null;
                    }
                case BuildOption.Run:
                    return runCoreAsync(res);
                default:
                    return Promise.resolve();
            }
        })
        .then(() => {
            return compileResult;
        });
}

export function staticpkgAsync(parsed: commandParser.ParsedCommand) {
    const route = parsed.flags["route"] as string || "/";
    const ghpages = parsed.flags["githubpages"];
    const builtPackaged = parsed.flags["output"] as string || "built/packaged";
    const minify = !!parsed.flags["minify"];
    const bump = !!parsed.flags["bump"];
    const disableAppCache = !!parsed.flags["no-appcache"];
    const locs = !!parsed.flags["locs"];
    if (parsed.flags["cloud"]) forceCloudBuild = true;
    if (minify && process.env["PXT_ENV"] === undefined) {
        process.env["PXT_ENV"] = "production";
    }

    pxt.log(`packaging editor to ${builtPackaged}`)

    let p = rimrafAsync(builtPackaged, {})
        .then(() => bump ? bumpAsync() : Promise.resolve())
        .then(() => locs && crowdin.downloadTargetTranslationsAsync())
        .then(() => internalBuildTargetAsync({ packaged: true }));
    if (ghpages) return p.then(() => ghpPushAsync(builtPackaged, minify));
    else return p.then(() => internalStaticPkgAsync(builtPackaged, route, minify, disableAppCache));
}

function internalStaticPkgAsync(builtPackaged: string, label: string, minify: boolean, noAppCache?: boolean) {
    const pref = path.resolve(builtPackaged);
    const localDir = !label ? "./" : `${U.startsWith(label, ".") || U.startsWith(label, "/") ? "" : "/"}${label}${U.endsWith(label, "/") ? "" : "/"}`;
    return uploadCoreAsync({
        label: label || "main",
        pkgversion: "0.0.0",
        fileList: pxtFileList("node_modules/pxt-core/")
            .concat(targetFileList())
            .concat(["targetconfig.json"])
            .concat(nodeutil.allFiles("built/hexcache")),
        localDir,
        target: (pxt.appTarget.id || "unknownstatic"),
        builtPackaged,
        minify,
        noAppCache
    }).then(() => renderDocs(builtPackaged, localDir))
}

export function cleanAsync(parsed?: commandParser.ParsedCommand) {
    pxt.log('cleaning built folders')
    return rimrafAsync("built", {})
        .then(() => rimrafAsync("temp", {}))
        .then(() => rimrafAsync("libs/**/built", {}))
        .then(() => rimrafAsync("projects/**/built", {}))
        .then(() => { });
}

export function cleanGenAsync(parsed: commandParser.ParsedCommand) {
    pxt.log('cleaning generated files')
    return Promise.resolve()
        .then(() => rimrafAsync("libs/**/enums.d.ts", {}))
        .then(() => rimrafAsync("libs/**/shims.d.ts", {}))
        .then(() => rimrafAsync("libs/**/_locales", {}))
        .then(() => { });
}

export function npmInstallNativeAsync() {
    pxt.log('installing npm native dependencies')
    const deps = nodeutil.lazyDependencies();
    const mods = Object.keys(deps).map(k => `${k}@${deps[k]}`);
    function nextAsync() {
        const mod = mods.pop();
        if (!mod) return Promise.resolve();

        return nodeutil.runNpmAsync("install", mod);
    }
    return nextAsync();
}

interface PNGImage {
    width: number;
    height: number;
    depth: number; // 8
    colorType: number; // 6
    data: Buffer;
}

interface SpriteGlobalMeta {
    star: pxt.JRes;
    basename?: string;
    width?: number;
    height?: number;
    blockIdentity: string;
    creator: string;
    tags?: string;
    standaloneSprites?: string[];
}

interface SpriteInfo {
    width?: number;
    height?: number;
    xSpacing?: number;
    ySpacing?: number;
    tags?: string;
    frames?: string[];
    blockIdentity?: string;
}



export function buildJResSpritesAsync(parsed: commandParser.ParsedCommand) {
    ensurePkgDir()
    return loadPkgAsync()
        .then(() => buildJResSpritesCoreAsync(parsed))
}

function buildJResSpritesCoreAsync(parsed: commandParser.ParsedCommand) {
    const PNG: any = require("pngjs").PNG;

    const dir = parsed.args[0]
    if (!dir)
        U.userError("missing directory argument");
    if (!nodeutil.existsDirSync(dir))
        U.userError(`directory '${dir}' does not exist`);

    // create meta.json file if needed
    const metaInfoPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaInfoPath)) {
        pxt.log(`${metaInfoPath} not found, creating new one`);
        fs.writeFileSync(metaInfoPath, JSON.stringify({
            "width": 16,
            "height": 16,
            "blockIdentity": "image.__imagePicker",
            "creator": "image.ofBuffer",
            "star": {
                "namespace": `sprites.${dir.toLowerCase()}`,
                "mimeType": "image/x-mkcd-f4"
            }
        }, null, 4));
    }

    const metaInfo: SpriteGlobalMeta = nodeutil.readJson(metaInfoPath)
    const jresources: pxt.Map<pxt.JRes> = {}
    const star = metaInfo.star

    jresources["*"] = metaInfo.star

    let bpp = 4

    if (/-f1/.test(star.mimeType))
        bpp = 1

    if (!metaInfo.star)
        U.userError(`invalid meta.json`)

    if (!metaInfo.basename) metaInfo.basename = star.namespace

    if (!metaInfo.basename)
        U.userError(`invalid meta.json`)

    star.dataEncoding = star.dataEncoding || "base64"

    if (!pxt.appTarget.runtime || !pxt.appTarget.runtime.palette)
        U.userError(`palette not defined in pxt.json`)

    const palette = pxt.appTarget.runtime.palette.map(s => {
        let v = parseInt(s.replace(/#/, ""), 16)
        return [(v >> 16) & 0xff, (v >> 8) & 0xff, (v >> 0) & 0xff]
    })

    let ts = `namespace ${metaInfo.star.namespace} {\n`

    for (let fn of nodeutil.allFiles(dir, 1)) {
        fn = fn.replace(/\\/g, "/")
        let m = /(.*\/)(.*)\.png$/i.exec(fn)
        if (!m) continue
        let bn = m[2]
        let jn = m[1] + m[2] + ".json"
        bn = bn.replace(/-1bpp/, "").replace(/[^\w]/g, "_")
        const standalone = metaInfo.standaloneSprites && metaInfo.standaloneSprites.indexOf(bn) !== -1;
        processImage(bn, fn, jn, standalone)
    }

    ts += "}\n"

    pxt.log(`save ${metaInfo.basename}.jres and .ts`)
    nodeutil.writeFileSync(metaInfo.basename + ".jres", nodeutil.stringify(jresources));
    nodeutil.writeFileSync(metaInfo.basename + ".ts", ts);

    return Promise.resolve()

    // use geometric distance on colors
    function scale(v: number) {
        return v * v
    }

    function closestColor(buf: Buffer, pix: number, alpha = true) {
        if (alpha && buf[pix + 3] < 100)
            return 0 // transparent
        let mindelta = 0
        let idx = -1
        for (let i = alpha ? 1 : 0; i < palette.length; ++i) {
            let delta = scale(palette[i][0] - buf[pix + 0]) + scale(palette[i][1] - buf[pix + 1]) + scale(palette[i][2] - buf[pix + 2])
            if (idx < 0 || delta < mindelta) {
                idx = i
                mindelta = delta
            }
        }
        return idx
    }

    function processImage(basename: string, pngName: string, jsonName: string, standalone: boolean) {
        let info: SpriteInfo = {}
        if (nodeutil.fileExistsSync(jsonName))
            info = nodeutil.readJson(jsonName)
        if (!info.width) info.width = metaInfo.width
        if (!info.height) info.height = metaInfo.height

        let sheet = PNG.sync.read(fs.readFileSync(pngName)) as PNGImage
        let imgIdx = 0

        // add alpha channel
        if (sheet.colorType == 0) {
            sheet.colorType = 6
            sheet.depth = 8
            for (let i = 0; i < sheet.data.length; i += 4) {
                if (closestColor(sheet.data, i, false) == 0)
                    sheet.data[i + 3] = 0x00
            }
        }

        if (sheet.colorType != 6)
            U.userError(`only RGBA png images supported`)
        if (sheet.depth != 8)
            U.userError(`only 8 bit per channel png images supported`)
        if (sheet.width > 255 || sheet.height > 255)
            U.userError(`PNG image too big`)

        if (standalone) {
            // Image contains a single sprite
            info.width = sheet.width;
            info.height = sheet.height;
        }
        else {
            if (!info.width || info.width > sheet.width) info.width = sheet.width
            if (!info.height || info.height > sheet.height) info.height = sheet.height
        }

        if (!info.xSpacing) info.xSpacing = 0;
        if (!info.ySpacing) info.ySpacing = 0;

        let nx = (sheet.width / info.width) | 0
        let ny = (sheet.height / info.height) | 0
        let numSprites = nx * ny

        for (let y = 0; y + info.height - 1 < sheet.height; y += info.height + info.ySpacing)
            for (let x = 0; x + info.width - 1 < sheet.width; x += info.width + info.xSpacing) {
                if (info.frames && imgIdx >= info.frames.length) return;

                let img = U.flatClone(sheet)
                img.data = Buffer.alloc(info.width * info.height * 4)
                img.width = info.width
                img.height = info.height
                for (let i = 0; i < info.height; ++i) {
                    let src = x * 4 + (y + i) * sheet.width * 4
                    sheet.data.copy(img.data, i * info.width * 4, src, src + info.width * 4)
                }
                let key = basename + imgIdx
                if (info.frames && info.frames[imgIdx]) {
                    let suff = info.frames[imgIdx]
                    if (/^[a-z]/.test(suff))
                        suff = "_" + suff
                    key = basename + suff
                } else if (numSprites == 1) {
                    key = basename
                }

                let hasNonTransparent = false;
                let hex = pxtc.f4EncodeImg(img.width, img.height, bpp, (x, y) => {
                    const col = closestColor(img.data, 4 * (x + y * img.width));
                    if (col)
                        hasNonTransparent = true;
                    return col;
                });

                if (!hasNonTransparent)
                    continue;

                let data = Buffer.from(hex, "hex").toString(star.dataEncoding)

                let storeIcon = false

                if (storeIcon) {
                    let jres = jresources[key]
                    if (!jres) {
                        jres = jresources[key] = {} as any
                    }
                    jres.data = data
                    jres.icon = 'data:image/png;base64,' + PNG.sync.write(img).toString('base64');
                } else {
                    // use the short form
                    jresources[key] = data as any
                }

                ts += `    //% fixedInstance jres blockIdentity=${info.blockIdentity || metaInfo.blockIdentity}\n`
                if (info.tags || metaInfo.tags) {
                    const tags = `${metaInfo.tags || ""} ${info.tags || ""}`;
                    ts += `    //% tags="${tags.trim()}"\n`;
                }
                ts += `    export const ${key} = ${metaInfo.creator}(hex\`\`);\n`

                pxt.log(`add ${key}; ${JSON.stringify(jresources[key]).length} bytes`)

                imgIdx++
            }
    }
}

export function buildJResAsync(parsed: commandParser.ParsedCommand) {
    ensurePkgDir();
    nodeutil.allFiles(".")
        .filter(f => /\.jres$/i.test(f))
        .forEach(f => {
            pxt.log(`expanding jres resources in ${f}`);
            const jresources = nodeutil.readJson(f) as pxt.Map<pxt.JRes>;
            const oldjr = nodeutil.stringify(jresources);
            const dir = path.join('jres', path.basename(f, '.jres'));
            // update existing fields
            const star = jresources["*"];
            if (!star.dataEncoding) star.dataEncoding = 'base64';
            Object.keys(jresources).filter(k => k != "*").forEach(k => {
                const jres = jresources[k];
                const mime = jres.mimeType || star.mimeType;
                pxt.log(`expanding ${k}`);
                // try to slurp icon
                const iconn = path.join(dir, k + '-icon.png');
                pxt.debug(`looking for ${iconn}`)
                if (nodeutil.fileExistsSync(iconn)) {
                    pxt.log(`importing ${iconn}`);
                    jres.icon = 'data:image/png;base64,' + fs.readFileSync(iconn, 'base64');
                }
                // try to find file
                if (mime) {
                    const ext = mime.replace(/^.*\//, '');
                    let fn = path.join(dir, k + '-data.' + ext);
                    pxt.debug(`looking for ${fn}`)
                    if (nodeutil.fileExistsSync(fn)) {
                        pxt.log(`importing ${fn}`);
                        jres.data = fs.readFileSync(fn, 'base64');
                    } else {
                        let fn = path.join(dir, k + '.' + ext);
                        pxt.debug(`looking for ${fn}`)
                        if (nodeutil.fileExistsSync(fn)) {
                            pxt.log(`importing ${fn}`);
                            jres.data = fs.readFileSync(fn, 'base64');
                        }
                    }
                }
            })

            const newjr = nodeutil.stringify(jresources);
            if (oldjr != newjr) {
                pxt.log(`updating ${f}`)
                nodeutil.writeFileSync(f, newjr);
            }
        })
    return Promise.resolve();
}

export function buildAsync(parsed: commandParser.ParsedCommand) {
    let mode = BuildOption.JustBuild;
    if (parsed && parsed.flags["debug"])
        mode = BuildOption.DebugSim;
    else if (parsed && parsed.flags["deploy"])
        mode = BuildOption.Deploy;
    const clean = parsed && parsed.flags["clean"];
    const warnDiv = parsed && !!parsed.flags["warndiv"];
    const ignoreTests = parsed && !!parsed.flags["ignoreTests"];
    const install = parsed && !!parsed.flags["install"];

    return (clean ? cleanAsync() : Promise.resolve())
        .then(() => install ? installAsync(parsed) : Promise.resolve())
        .then(() => {
            parseBuildInfo(parsed);
            return buildCoreAsync({ mode, warnDiv, ignoreTests })
        }).then((compileOpts) => { });
}

export function gendocsAsync(parsed: commandParser.ParsedCommand) {
    const docs = !!parsed.flags["docs"];
    const locs = !!parsed.flags["locs"];
    const fileFilter = parsed.flags["files"] as string;
    const createOnly = !!parsed.flags["create"];
    return internalGenDocsAsync(docs, locs, fileFilter, createOnly);
}

function internalGenDocsAsync(docs: boolean, locs: boolean, fileFilter?: string, createOnly?: boolean) {
    const buildAsync = () => buildCoreAsync({
        mode: BuildOption.GenDocs,
        docs,
        locs,
        fileFilter,
        createOnly
    }).then((compileOpts) => { });

    // from target location?
    if (fs.existsSync("pxtarget.json") && !!readJson("pxtarget.json").appTheme)
        return forEachBundledPkgAsync((pkg, dirname) => {
            pxt.debug(`building docs in ${dirname}`);
            return buildAsync();
        });
    else // from a project build
        return buildAsync();
}

export function consoleAsync(parsed?: commandParser.ParsedCommand): Promise<void> {
    pxt.log(`monitoring console.log`)
    if (!hid.isInstalled()) {
        pxt.log(`console support not installed, did you run "pxt npminstallnative"?`)
        return Promise.resolve();
    }
    return hid.serialAsync();
}

export function deployAsync(parsed?: commandParser.ParsedCommand) {
    parseBuildInfo(parsed);
    const serial = parsed && !!parsed.flags["console"];
    return buildCoreAsync({ mode: BuildOption.Deploy })
        .then((compileOpts) => serial ? consoleAsync(parsed) : Promise.resolve())
}

export function runAsync(parsed?: commandParser.ParsedCommand) {
    parseBuildInfo(parsed);
    return buildCoreAsync({ mode: BuildOption.Run })
        .then((compileOpts) => { });
}

export function testAsync() {
    return buildCoreAsync({ mode: BuildOption.Test })
        .then((compileOpts) => { });
}

export interface SavedProject {
    name: string;
    files: Map<string>;
}

export function extractAsync(parsed: commandParser.ParsedCommand): Promise<void> {
    const vscode = !!parsed.flags["code"];
    const out = parsed.flags["code"] || '.';
    const filename = parsed.args[0];
    return extractAsyncInternal(filename, out as string, vscode);
}

function isScriptId(id: string) {
    return /^((_[a-zA-Z0-9]{12})|([\d\-]{20,}))$/.test(id)
}

function fetchTextAsync(filename: string): Promise<Buffer> {
    if (filename == "-" || !filename)
        return nodeutil.readResAsync(process.stdin)

    if (isScriptId(filename))
        filename = Cloud.apiRoot + filename + "/text"

    let m = /^(https:\/\/[^\/]+\/)([^\/]+)$/.exec(filename)
    let fn2 = ""

    if (m) {
        let id = m[2]
        if (/^api\//.test(id)) id = id.slice(4)
        if (isScriptId(id)) {
            fn2 = m[1] + "api/" + id + "/text"
        }
    }

    if (/^https?:/.test(filename)) {
        pxt.log(`fetching ${filename}...`)
        if (/\.json$/i.test(filename)) pxt.log(`compile log: ${filename.replace(/\.json$/i, ".log")}`)
        return U.requestAsync({ url: filename, allowHttpErrors: !!fn2 })
            .then(resp => {
                if (fn2 && (resp.statusCode != 200 || /html/.test(resp.headers["content-type"] as string))) {
                    pxt.log(`Trying also ${fn2}...`)
                    return U.requestAsync({ url: fn2 })
                } return resp
            })
            .then(resp => resp.buffer)
    } else
        return readFileAsync(filename)
}

function extractAsyncInternal(filename: string, out: string, vscode: boolean): Promise<void> {
    if (filename && nodeutil.existsDirSync(filename)) {
        pxt.log(`extracting folder ${filename}`);
        return Promise.all(fs.readdirSync(filename)
            .filter(f => /\.(hex|uf2)/.test(f))
            .map(f => extractAsyncInternal(path.join(filename, f), out, vscode)))
            .then(() => { });
    }

    return fetchTextAsync(filename)
        .then(buf => extractBufferAsync(buf, out))
        .then(dirs => {
            if (dirs && vscode) {
                pxt.debug('launching code...')
                dirs.forEach(dir => openVsCode(dir));
            }
        })
}

function extractBufferAsync(buf: Buffer, outDir: string): Promise<string[]> {
    const oneFile = (src: string, editor: string) => {
        let files: any = {}
        files["main." + (editor || "td")] = src || ""
        return files
    }

    const unpackHexAsync = (buf: Buffer) =>
        pxt.cpp.unpackSourceFromHexAsync(buf as any)
            .then(data => {
                if (!data) return null
                if (!data.meta) data.meta = {} as any
                let id = data.meta.cloudId || "?"
                console.log(`.hex/uf2 cloudId: ${id}`)
                if (data.meta.targetVersions)
                    console.log(`target version: ${data.meta.targetVersions.target}, pxt ${data.meta.targetVersions.pxt}`);
                let files: Map<string> = null
                try {
                    files = JSON.parse(data.source)
                } catch (e) {
                    files = oneFile(data.source, data.meta.editor)
                }
                return {
                    projects: [
                        {
                            name: data.meta.name,
                            files: files
                        }
                    ]
                }
            })

    return Promise.resolve()
        .then(() => {
            let str = buf.toString("utf8")
            if (str[0] == ":") {
                console.log("Detected .hex file.")
                return unpackHexAsync(buf)
            } else if (str[0] == "U") {
                console.log("Detected .uf2 file.")
                return unpackHexAsync(buf)
            } else if (str[0] == "{") {  // JSON
                console.log("Detected .json file.")
                return JSON.parse(str)
            } else if (buf[0] == 0x5d) { // JSZ
                console.log("Detected .jsz/.pxt file.")
                return pxt.lzmaDecompressAsync(buf as any)
                    .then(str => JSON.parse(str))
            } else
                return Promise.resolve(null)
        })
        .then(json => {
            if (!json) {
                console.log("Couldn't extract.")
                return undefined;
            }
            if (json.meta && json.source) {
                json = typeof json.source == "string" ? JSON.parse(json.source) : json.source
            }
            if (Array.isArray(json.scripts)) {
                console.log("Legacy TD workspace.")
                json.projects = json.scripts.map((scr: any) => ({
                    name: scr.header.name,
                    files: oneFile(scr.source, scr.header.editor)
                }))
                delete json.scripts
            }

            if (json[pxt.CONFIG_NAME]) {
                console.log("Raw JSON files.")
                let cfg: pxt.PackageConfig = JSON.parse(json[pxt.CONFIG_NAME])
                let files = json
                json = {
                    projects: [{
                        name: cfg.name,
                        files: files
                    }]
                }
            }

            let prjs: SavedProject[] = json.projects
            if (!prjs) {
                console.log("No projects found.")
                return undefined;
            }
            const dirs = writeProjects(prjs, outDir)
            return dirs;
        })
}

export function hexdumpAsync(c: commandParser.ParsedCommand) {
    let filename = c.args[0]
    let buf = fs.readFileSync(filename)
    if (/^UF2\n/.test(buf.slice(0, 4).toString("utf8"))) {
        let r = pxtc.UF2.toBin(buf as any)
        if (r) {
            console.log("UF2 file detected.")
            console.log(pxtc.hexDump(r.buf, r.start))
            return Promise.resolve()
        }
    }
    console.log("Binary file assumed.")
    console.log(pxtc.hexDump(buf))
    return Promise.resolve()
}

export function hex2uf2Async(c: commandParser.ParsedCommand) {
    let filename = c.args[0]
    let buf = fs.readFileSync(filename, "utf8").split(/\r?\n/)
    if (buf[0][0] != ':') {
        console.log("Not a hex file: " + filename)
    } else {
        let f = pxtc.UF2.newBlockFile()
        pxtc.UF2.writeHex(f, buf)
        let uf2buf = Buffer.from(pxtc.UF2.serializeFile(f), "binary")
        let uf2fn = filename.replace(/(\.hex)?$/i, ".uf2")
        nodeutil.writeFileSync(uf2fn, uf2buf)
        console.log("Wrote: " + uf2fn)
    }
    return Promise.resolve()
}

function openVsCode(dirname: string) {
    child_process.exec(`code -g main.ts ${dirname}`); // notice this without a callback..
}

function writeProjects(prjs: SavedProject[], outDir: string): string[] {
    const dirs: string[] = [];
    for (let prj of prjs) {
        const dirname = prj.name.replace(/[^A-Za-z0-9_]/g, "-")
        const fdir = path.join(outDir, dirname);
        nodeutil.mkdirP(fdir);
        for (let fn of Object.keys(prj.files)) {
            fn = fn.replace(/[\/]/g, "-")
            const fullname = path.join(fdir, fn)
            nodeutil.mkdirP(path.dirname(fullname));
            nodeutil.writeFileSync(fullname, prj.files[fn])
        }
        // add default files if not present
        const files = pxt.template.packageFiles(prj.name);
        pxt.template.packageFilesFixup(files);
        for (let fn in files) {
            if (prj.files[fn]) continue;
            const fullname = path.join(fdir, fn)
            nodeutil.mkdirP(path.dirname(fullname));
            const src = files[fn];
            nodeutil.writeFileSync(fullname, src)
        }

        // start installing in the background
        child_process.exec(`pxt install`, { cwd: dirname });

        dirs.push(dirname);
    }
    return dirs;
}

function cherryPickAsync(parsed: commandParser.ParsedCommand) {
    const commit = parsed.args[0];
    const name = parsed.flags["name"] || commit.slice(0, 7);
    let majorVersion = parseInt(pxtVersion().split('.')[0]);
    const gitAsync = (args: string[]) => nodeutil.spawnAsync({
        cmd: "git",
        args
    })

    let branches: string[] = [];
    for (let i = majorVersion - 1; i >= 0; --i) branches.push("v" + i);
    pxt.log(`cherry picking ${commit} into ${branches.join(', ')}`)

    let p = gitAsync(["pull"]);
    branches.forEach(branch => {
        const pr = `cp/${branch}${name}`;
        p = p.then(() => gitAsync(["checkout", branch]))
            .then(() => gitAsync(["pull"]))
            .then(() => gitAsync(["checkout", "-b", pr]))
            .then(() => gitAsync(["cherry-pick", commit]))
            .then(() => gitAsync(["push", "--set-upstream", "origin", pr]));
    })

    return p.catch(() => gitAsync(["checkout", "master"]));
}

function checkDocsAsync(parsed?: commandParser.ParsedCommand): Promise<void> {
    return internalCheckDocsAsync(
        true,
        parsed.flags["re"] as string,
        !!parsed.flags["fix"],
        !!parsed.flags["pycheck"]
    )
}

function checkFileSize(files: string[]): number {
    if (!pxt.appTarget.cloud)
        return 0;

    pxt.log('checking for file sizes');
    const mb = 1e6;
    const warnSize = pxt.appTarget.cloud.warnFileSize || (1 * mb);
    let maxSize = 0;
    files.forEach(f => {
        const stats = fs.statSync(f);
        if (stats.size > warnSize)
            pxt.log(`  ${f} - ${stats.size / mb}Mb`);
        maxSize = Math.max(maxSize, stats.size);
    });
    return maxSize;
}

function internalCheckDocsAsync(compileSnippets?: boolean, re?: string, fix?: boolean, pycheck?: boolean): Promise<void> {
    if (!nodeutil.existsDirSync("docs"))
        return Promise.resolve();
    const docsRoot = nodeutil.targetDir;
    const docsTemplate = server.expandDocFileTemplate("docs.html")
    pxt.log(`checking docs`);

    const noTOCs: string[] = [];
    const todo: string[] = [];
    let urls: any = {};
    let checked = 0;
    let broken = 0;
    let snippets: CodeSnippet[] = [];

    const maxFileSize = checkFileSize(nodeutil.allFiles("docs", 10, true, true, ".ignorelargefiles"));
    if (!pxt.appTarget.ignoreDocsErrors
        && maxFileSize > (pxt.appTarget.cloud.maxFileSize || (5000000)))
        U.userError(`files too big in docs folder`);

    // scan and fix image links
    nodeutil.allFiles("docs")
        .filter(f => /\.md/.test(f))
        .forEach(f => {
            let md = fs.readFileSync(f, { encoding: "utf8" });
            let newmd = md.replace(/]\((\/static\/[^)]+?)\.(png|jpg)(\s+"[^"]+")?\)/g, (m: string, p: string, ext: string, comment: string) => {
                let fn = path.join(docsRoot, "docs", `${p}.${ext}`);
                if (fs.existsSync(fn))
                    return m;
                // try finding other file
                let next = ext == "png" ? "jpg" : "png";
                const exists = fs.existsSync(path.join(docsRoot, "docs", `${p}.${next}`));
                if (exists && fix)
                    return `](${p}.${next}${comment ? " " : ""}${comment || ""})`;

                // broken image or resources
                broken++;
                pxt.log(`missing file ${p}.${ext}`)
                return m;
            });
            if (fix && md != newmd) {
                pxt.log(`patching ${f}`)
                nodeutil.writeFileSync(f, newmd, { encoding: "utf8" })
            }
        });

    function addSnippet(snippet: CodeSnippet, entryPath: string, snipIndex: number) {
        snippets.push(snippet);
        const dir = path.join("temp/snippets", snippet.type);
        const fn = `${dir}/${entryPath.replace(/^\//, '').replace(/\//g, '-').replace(/\.\w+$/, '')}-${snipIndex}.${snippet.ext}`;
        nodeutil.mkdirP(dir);
        nodeutil.writeFileSync(fn, snippet.code);
        snippet.file = fn;
    }

    function pushUrl(url: string, toc: boolean) {
        // cache value
        if (!urls.hasOwnProperty(url)) {
            const specialPath = /^\/pkg\//.test(url) || /^\/--[a-z]+/.test(url);
            if (specialPath) {
                urls[url] = url;
                return;
            }
            const isResource = /\.[a-z]+$/i.test(url)
            if (!isResource && !toc) {
                pxt.debug(`link not in SUMMARY: ${url}`);
                noTOCs.push(url);
            }
            // TODO: correct resolution of static resources
            urls[url] = isResource
                ? nodeutil.fileExistsSync(path.join(docsRoot, "docs", url))
                : nodeutil.resolveMd(docsRoot, url);
            if (!isResource && urls[url])
                todo.push(url);
        }
    }

    function checkTOCEntry(entry: pxt.TOCMenuEntry) {
        if (entry.path && !/^https:\/\//.test(entry.path)) {
            pushUrl(entry.path, true);
            if (!urls[entry.path]) {
                pxt.log(`SUMMARY: broken link ${entry.path}`);
                broken++;
            }
        }
        // look for sub items
        if (entry.subitems)
            entry.subitems.forEach(checkTOCEntry);
    }

    // check over TOCs
    nodeutil.allFiles("docs", 5).filter(f => /SUMMARY\.md$/.test(f))
        .forEach(summaryFile => {
            const summaryPath = path.join(path.dirname(summaryFile), 'SUMMARY').replace(/^docs[\/\\]/, '');
            pxt.log(`looking for ${summaryPath}`);
            const summaryMD = nodeutil.resolveMd(docsRoot, summaryPath);
            const toc = pxt.docs.buildTOC(summaryMD);
            if (!toc) {
                pxt.log(`invalid SUMMARY`);
                broken++;
            } else {
                toc.forEach(checkTOCEntry);
            }
        });

    // push entries from pxtarget
    const theme = pxt.appTarget.appTheme;
    if (theme) {
        if (theme.sideDoc)
            todo.push(theme.sideDoc);
        if (theme.usbDocs)
            todo.push(theme.usbDocs);
    }

    // push galleries for targetconfig
    if (fs.existsSync("targetconfig.json")) {
        const targeConfig = nodeutil.readJson("targetconfig.json") as pxt.TargetConfig;
        if (targeConfig.galleries)
            Object.keys(targeConfig.galleries)
                .forEach(gallery => {
                    const url = getGalleryUrl(targeConfig.galleries[gallery])
                    todo.push(url)
                });
    }

    // push files from targetconfig checkdocsdirs
    const mdRegex = /\.md$/;
    const targetDirs = pxt.appTarget.checkdocsdirs;
    if (targetDirs) {
        targetDirs.forEach(dir => {
            pxt.log(`looking for markdown files in ${dir}`);
            nodeutil.allFiles(path.join("docs", dir), 3).filter(f => mdRegex.test(f))
                .forEach(md => {
                    pushUrl(md.slice(5).replace(mdRegex, ""), true);
                });
        })
    }

    while (todo.length) {
        checked++;
        const entrypath = todo.pop();
        pxt.debug(`checking ${entrypath}`)
        let md = (urls[entrypath] as string) || nodeutil.resolveMd(docsRoot, entrypath);
        if (!md) {
            pxt.log(`unable to resolve ${entrypath}`)
            broken++;
        }
        // look for broken urls
        md.replace(/]\( (\/[^)]+?)(\s+"[^"]+")?\)/g, (m) => {
            let url = /]\((\/[^)]+?)(\s+"[^"]+")?\)/.exec(m)[1];
            // remove hash
            url = url.replace(/#.*$/, '');
            pushUrl(url, false);
            if (!urls[url]) {
                pxt.log(`${entrypath}: broken link ${url}`);
                broken++;
            }
            return '';
        })

        // look for broken macros
        try {
            const r = pxt.docs.renderMarkdown({
                template: docsTemplate,
                markdown: md,
                theme: pxt.appTarget.appTheme,
                throwOnError: true
            });
        } catch (e) {
            pxt.log(`${entrypath}: ${e}`);
            broken++;
        }

        // look for snippets
        getCodeSnippets(entrypath, md).forEach((snippet, snipIndex) => addSnippet(snippet, entrypath, snipIndex));
    }

    nodeutil.mkdirP("temp");
    nodeutil.writeFileSync("temp/noSUMMARY.md", noTOCs.sort().map(p => `${Array(p.split(/[\/\\]/g).length - 1).join('     ')}* [${pxt.Util.capitalize(p.split(/[\/\\]/g).reverse()[0].split('-').join(' '))}](${p})`).join('\n'), { encoding: "utf8" });

    // test targetconfig
    if (nodeutil.fileExistsSync("targetconfig.json")) {
        const targetConfig = nodeutil.readJson("targetconfig.json") as pxt.TargetConfig;
        if (targetConfig && targetConfig.galleries) {
            Object.keys(targetConfig.galleries).forEach(k => {
                pxt.log(`gallery ${k}`);
                const galleryUrl = getGalleryUrl(targetConfig.galleries[k])
                let gallerymd = nodeutil.resolveMd(docsRoot, galleryUrl);
                let gallery = pxt.gallery.parseGalleryMardown(gallerymd);
                pxt.debug(`found ${gallery.length} galleries`);
                gallery.forEach(gal => gal.cards.forEach((card, cardIndex) => {
                    pxt.debug(`card ${card.shortName || card.name}`);
                    switch (card.cardType) {
                        case "tutorial": {
                            let urls = [card.url]
                            if (card.otherActions) card.otherActions.forEach(a => { if (a.url) urls.push(a.url) });
                            for (let url of urls) {
                                const tutorialMd = nodeutil.resolveMd(docsRoot, url);
                                const tutorial = pxt.tutorial.parseTutorial(tutorialMd);
                                const pkgs: pxt.Map<string> = { "blocksprj": "*" };
                                pxt.Util.jsonMergeFrom(pkgs, pxt.gallery.parsePackagesFromMarkdown(tutorialMd) || {});

                                // Handles tilemaps, spritekinds
                                if (tutorial.code.indexOf("namespace") !== -1
                                    // Handles ```python``` snippets
                                    || (tutorial.language == "python")) {
                                    tutorial.steps
                                        .filter(step => !!step.contentMd)
                                        .forEach((step, stepIndex) => getCodeSnippets(`${gal.name}-${stepIndex}`, step.contentMd)
                                            .forEach((snippet, snippetIndex) => {
                                                snippet.packages = pkgs;
                                                addSnippet(
                                                    snippet,
                                                    "tutorial" + `${gal.name}-${stepIndex}-${snippetIndex}`,
                                                    cardIndex
                                                )
                                            })
                                        );
                                }
                                else {
                                    addSnippet(<CodeSnippet>{
                                        name: card.name,
                                        code: tutorial.code,
                                        type: "blocks",
                                        ext: "ts",
                                        packages: pkgs
                                    }, "tutorial" + gal.name, cardIndex);
                                }
                            }

                            break;
                        }
                        case "example": {
                            let urls = [card.url]
                            if (card.otherActions) card.otherActions.forEach(a => { if (a.url) urls.push(a.url) });
                            for (let url of urls) {
                                const exMd = nodeutil.resolveMd(docsRoot, url);
                                const prj = pxt.gallery.parseExampleMarkdown(card.name, exMd);
                                const pkgs: pxt.Map<string> = { "blocksprj": "*" };
                                pxt.U.jsonMergeFrom(pkgs, prj.dependencies);
                                addSnippet(<CodeSnippet>{
                                    name: card.name,
                                    code: prj.filesOverride["main.ts"],
                                    type: "blocks",
                                    ext: "ts",
                                    packages: pkgs
                                }, "example" + gal.name, cardIndex);
                            }
                            break;
                        }
                    }
                }));
            })
        }
    }

    pxt.log(`checked ${checked} files: ${broken} broken links, ${noTOCs.length} not in SUMMARY, ${snippets.length} snippets`);
    let p = Promise.resolve();
    if (compileSnippets)
        p = p.then(() => testSnippetsAsync(snippets, re, pycheck));
    return p.then(() => {
        if (broken > 0) {
            const msg = `${broken} broken links found in the docs`;
            if (pxt.appTarget.ignoreDocsErrors) pxt.log(msg)
            else U.userError(msg);
        }
    })
}

export interface SnippetInfo {
    type: string;
    code: string;
    ignore: boolean;
    index: number;
}

export function getSnippets(source: string): SnippetInfo[] {
    let snippets: SnippetInfo[] = []
    let re = /^`{3}([\S]+)?\s*\n([\s\S]+?)\n`{3}\s*?$/gm;
    let index = 0
    source.replace(re, (match, type, code) => {
        snippets.push({
            type: type ? type.replace(/-ignore$/i, "") : "pre",
            code: code,
            ignore: type ? /-ignore/g.test(type) : false,
            index: index
        })
        index++
        return ''
    })
    return snippets
}

export interface CodeSnippet {
    name: string;
    code: string;
    type: string;
    ext: string;
    packages: pxt.Map<string>;
    file?: string;
}

export function getCodeSnippets(fileName: string, md: string): CodeSnippet[] {
    const supported: pxt.Map<string> = {
        "blocks": "ts",
        "block": "ts",
        "typescript": "ts",
        "sig": "ts",
        "namespaces": "ts",
        "cards": "ts",
        "sim": "ts",
        "ghost": "ts",
        "codecard": "json",
        "python": "py"
    }
    let snippets = getSnippets(md);
    const codeSnippets = snippets.filter(snip => !snip.ignore && !!supported[snip.type]);
    const pkgs: pxt.Map<string> = {
        "blocksprj": "*"
    }
    snippets.filter(snip => snip.type == "package")
        .map(snip => snip.code.split('\n'))
        .forEach(lines => lines
            .map(l => l.replace(/\s*$/, ''))
            .filter(line => !!line)
            .forEach(line => {
                const i = line.indexOf('=');
                if (i < 0) pkgs[line] = "*";
                else pkgs[line.substring(0, i)] = line.substring(i + 1);
            })
        );

    const pkgName = fileName.replace(/\\/g, '-').replace(/.md$/i, '');
    return codeSnippets.map((snip, i) => {
        return {
            name: `${pkgName}-${i}`,
            code: snip.code,
            type: snip.type,
            ext: supported[snip.type],
            packages: pkgs
        };
    })
}

function webstringsJson() {
    let missing: Map<string> = {}
    const files = onlyExts(nodeutil.allFiles("docfiles"), [".html"])
        .concat(onlyExts(nodeutil.allFiles("docs"), [".html"]))
    for (let fn of files) {
        let res = pxt.docs.translate(fs.readFileSync(fn, "utf8"), {})
        U.jsonCopyFrom(missing, res.missing)
    }
    U.iterMap(missing, (k, v) => {
        missing[k] = k
    })
    missing = U.sortObjectFields(missing)
    return missing
}

function extractLocStringsAsync(output: string, dirs: string[]): Promise<void> {
    let prereqs: string[] = [];
    dirs.forEach(dir => prereqs = prereqs.concat(nodeutil.allFiles(dir, 20)));

    let errCnt = 0;
    let translationStrings: pxt.Map<string> = {}

    function processLf(filename: string) {
        if (!/\.(ts|tsx|html)$/.test(filename)) return
        if (/\.d\.ts$/.test(filename)) return

        pxt.debug(`extracting strings from${filename}`);
        fs.readFileSync(filename, "utf8").split('\n').forEach((line: string, idx: number) => {
            function err(msg: string) {
                console.log("%s(%d): %s", filename, idx, msg);
                errCnt++;
            }

            while (true) {
                let newLine = line.replace(/\blf(_va)?\s*\(\s*(.*)/, (all, a, args) => {
                    let m = /^("([^"]|(\\"))+")\s*[\),]/.exec(args)
                    if (m) {
                        try {
                            let str = JSON.parse(m[1])
                            translationStrings[str] = str;
                        } catch (e) {
                            err("cannot JSON-parse " + m[1])
                        }
                    } else {
                        if (!/util\.ts$/.test(filename))
                            err("invalid format of lf() argument: " + args)
                    }
                    return "BLAH " + args
                })
                if (newLine == line) return;
                line = newLine
            }
        })
    }

    let fileCnt = 0;
    prereqs.forEach(pth => {
        fileCnt++;
        processLf(pth);
    });

    let tr = Object.keys(translationStrings)
    tr.sort()
    let strings: pxt.Map<string> = {};
    tr.forEach(function (k) { strings[k] = k; });

    nodeutil.mkdirP('built');
    nodeutil.writeFileSync(`built/${output}.json`, nodeutil.stringify(strings));

    pxt.log("log strings: " + fileCnt + " files; " + tr.length + " strings -> " + output + ".json");
    if (errCnt > 0)
        pxt.log(`${errCnt} errors`);
    return Promise.resolve();
}

function testGithubPackagesAsync(parsed: commandParser.ParsedCommand): Promise<void> {
    pxt.log(`-- testing github packages-- `);
    pxt.log(`make sure to store your github token (GITHUB_ACCESS_TOKEN/GITHUB_TOKEN env var) to avoid throttling`)
    if (!fs.existsSync("targetconfig.json")) {
        pxt.log(`targetconfig.json not found`);
        return Promise.resolve();
    }
    parseBuildInfo(parsed);
    const warnDiv = !!parsed.flags["warndiv"];
    const clean = !!parsed.flags["clean"];
    const targetConfig = nodeutil.readJson("targetconfig.json") as pxt.TargetConfig;
    const packages = targetConfig.packages;
    if (!packages) {
        pxt.log(`packages section not found in targetconfig.json`)
    }
    let errors: string[] = [];
    let todo: string[];
    const repos: pxt.Map<{ fullname: string; tag: string }> = {};
    const pkgsroot = path.join("temp", "ghpkgs");

    function detectDivision(code: string): boolean {
        // remove /* comments
        code = code.replace(/\/\*(.|\s)*?\*\//gi, '');
        // remove // ... comments
        code = code.replace(/\/\/.*?$/gim, '');
        // search for comments
        return /[^\/*]=?\/[^\/*]/.test(code);
    }

    function gitAsync(dir: string, ...args: string[]) {
        return nodeutil.spawnAsync({
            cmd: "git",
            args: args,
            cwd: dir
        })
    }

    function pxtAsync(dir: string, args: string[]) {
        return nodeutil.spawnAsync({
            cmd: "node",
            args: [path.join(process.cwd(), "node_modules", "pxt-core", "pxt-cli", "cli.js")].concat(args),
            cwd: dir
        })
    }


    function nextAsync(): Promise<void> {
        const pkgpgh = todo.pop();
        if (!pkgpgh) {
            pxt.log('')
            pxt.log(`------------------------`)
            pxt.log(`${errors.length} packages with errors`);
            errors.forEach(er => pxt.log(`- [ ]  ${er}`));
            return Promise.resolve();
        }
        pxt.log('')
        pxt.log(`  testing ${pkgpgh}`)
        // clone or sync package
        const buildArgs = ["build", "--ignoreTests"];
        if (warnDiv) buildArgs.push("--warndiv");
        if (forceLocalBuild) buildArgs.push("--localbuild");
        const pkgdir = path.join(pkgsroot, pkgpgh);
        return (
            !nodeutil.existsDirSync(pkgdir)
                ? gitAsync(".", "clone", "-q", "-b", repos[pkgpgh].tag, `https://github.com/${pkgpgh}`, pkgdir)
                : gitAsync(pkgdir, "fetch").then(() => gitAsync(pkgdir, "checkout", "-f", repos[pkgpgh].tag))
        )
            .then(() => pxtAsync(pkgdir, ["clean"]))
            .then(() => pxtAsync(pkgdir, ["install"]))
            .then(() => pxtAsync(pkgdir, buildArgs))
            .then(() => {
                if (warnDiv) {
                    // perform a regex search over the repo for / operator
                    const filesWithDiv: pxt.Map<boolean> = {};
                    nodeutil.allFiles(pkgdir, 1)
                        .filter(f => /\.ts$/i.test(f))
                        .forEach(f => detectDivision(fs.readFileSync(f, { encoding: "utf8" }))
                            ? (filesWithDiv[f.replace(pkgdir, '').replace(/^[\/\\]/, '')] = true)
                            : false);
                    const fsw = Object.keys(filesWithDiv);
                    if (fsw.length) {
                        errors.push(`${pkgpgh} div found in ${fsw.join(', ')}`);
                        pxt.log(errors[errors.length - 1])
                    }
                }
            })
            .catch(e => {
                errors.push(`${pkgpgh} ${e}`);
                pxt.log(e);
                return Promise.resolve();
            })
            .then(() => nextAsync());
    }

    // 1. collect packages
    return loadGithubTokenAsync()
        .then(() => clean ? rimrafAsync(pkgsroot, {}) : Promise.resolve())
        .then(() => nodeutil.mkdirP(pkgsroot))
        .then(() => pxt.github.searchAsync("", packages))
        .then(ghrepos => ghrepos.filter(ghrepo => ghrepo.status == pxt.github.GitRepoStatus.Approved)
            .map(ghrepo => ghrepo.fullName).concat(packages.approvedRepos || []))
        .then(fullnames => {
            // remove dups
            fullnames = U.unique(fullnames, f => f.toLowerCase());
            pxt.log(`found ${fullnames.length} approved packages`);
            pxt.log(nodeutil.stringify(fullnames));
            return Promise.all(fullnames.map(fullname => pxt.github.listRefsAsync(fullname)
                .then(tags => {
                    const tag = pxt.semver.sortLatestTags(tags)[0];
                    if (!tag) {
                        errors.push(`${fullname}: no valid release found`);
                        pxt.log(errors[errors.length - 1]);
                    }
                    else
                        repos[fullname] = { fullname, tag };
                }))
            );
        }).then(() => {
            todo = Object.keys(repos);
            pxt.log(`found ${todo.length} approved package with releases`);
            todo.forEach(fn => pxt.log(`  ${fn}#${repos[fn].tag}`));
            // 2. process each repo
            return nextAsync();
        });
}

interface BlockTestCase {
    packageName: string;
    testFiles: { testName: string, contents: string }[];
}

function blockTestsAsync(parsed?: commandParser.ParsedCommand) {
    let cmd = karmaPath();
    if (!cmd) {
        console.error("Karma not found, did you run npm install?");
        return Promise.reject(new Error("Karma not found"));
    }

    const args = ["start", path.resolve("node_modules/pxt-core/tests/blocks-test/karma.conf.js")];

    if (parsed && parsed.flags["debug"]) {
        args.push("--no-single-run");
    }

    if (process.env.GITHUB_ACTIONS) {
        args.unshift(cmd);
        args.unshift("--auto-servernum");
        cmd = "xvfb-run"
    }

    return writeBlockTestJSONAsync()
        .then(() => nodeutil.spawnAsync({
            cmd,
            envOverrides: {
                "KARMA_TARGET_DIRECTORY": process.cwd()
            },
            args
        }), (e: Error) => console.log("Skipping blocks tests: " + e.message))

    function getBlocksFilesAsync(libsDirectory: string): Promise<BlockTestCase[]> {
        return readDirAsync(libsDirectory)
            .then(dirs => Promise.map(dirs, dir => {
                const dirPath = path.resolve(libsDirectory, dir, "blocks-test");
                const configPath = path.resolve(libsDirectory, dir, "pxt.json");
                let packageName: string;
                let testFiles: { testName: string, contents: string }[] = [];

                if (fs.existsSync(path.resolve(configPath)) && nodeutil.existsDirSync(dirPath)) {
                    return readFileAsync(configPath, "utf8")
                        .then((configText: string) => {
                            packageName = (JSON.parse(configText) as pxt.PackageConfig).name;
                            return readDirAsync(dirPath)
                                .then(files => Promise.map(files.filter(f => U.endsWith(f, ".blocks") && f != "main.blocks"), fn =>
                                    readFileAsync(path.join(dirPath, fn), "utf8")
                                        .then((contents: string) => testFiles.push({ testName: fn, contents }))))
                        })
                        .then(() => { return ({ packageName, testFiles } as BlockTestCase) })
                }
                return Promise.resolve(undefined);
            }))
            .then((allCases: BlockTestCase[]) => allCases.filter(f => !!f && f.testFiles.length && f.packageName));
    }

    function writeBlockTestJSONAsync() {
        let libsTests: BlockTestCase[];
        let commonTests: BlockTestCase[];
        return getBlocksFilesAsync(path.resolve("libs"))
            .then(files => {
                libsTests = files;
                const commonLibs = path.resolve("node_modules/pxt-common-packages/libs");
                if (nodeutil.existsDirSync(commonLibs))
                    return getBlocksFilesAsync(commonLibs)
                else {
                    return Promise.resolve([]);
                }
            })
            .then(files => {
                commonTests = files;

                if (!commonTests.length && !libsTests.length) return Promise.reject(new Error("No test cases found"));

                return writeFileAsync(path.resolve("built/block-tests.js"), "var testJSON = " + JSON.stringify({
                    libsTests, commonTests
                }), "utf8")
            })
    }

    function karmaPath() {
        const karmaCommand = os.platform() === "win32" ? "karma.cmd" : "karma";
        const localModule = path.resolve("node_modules", ".bin", karmaCommand);
        const coreModule = path.resolve("node_modules", "pxt-core", "node_modules", ".bin", karmaCommand);

        if (fs.existsSync(localModule)) {
            return localModule;
        }
        else if (fs.existsSync(coreModule)) {
            return coreModule;
        }
        return undefined;
    }
}

function initCommands() {
    // Top level commands
    simpleCmd("help", "display this message or info about a command", pc => {
        p.printHelp(pc.args, console.log)
        console.log(`
The following environment variables modify the behavior of the CLI when set to
non-empty string:

PXT_DEBUG        - display extensive logging info
PXT_USE_HID      - use webusb or hid to flash device

These apply to the C++ runtime builds:

PXT_FORCE_LOCAL  - compile C++ on the local machine, not the cloud service
PXT_NODOCKER     - don't use Docker image, and instead use host's
                   arm-none-eabi-gcc (doesn't apply to Linux targets)
PXT_RUNTIME_DEV  - always rebuild the C++ runtime, allowing for modification
                   in the lower level runtime if any
PXT_ASMDEBUG     - embed additional information in generated binary.asm file
PXT_ACCESS_TOKEN - pxt access token
GITHUB_ACCESS_TOKEN/GITHUB_TOKEN - github access token
${pxt.crowdin.KEY_VARIABLE} - crowdin key
`)
        return Promise.resolve();
    }, "[all|command]");

    p.defineCommand({
        name: "deploy",
        help: "build and deploy current package",
        flags: {
            "console": { description: "start console monitor after deployment", aliases: ["serial"] },
            cloudbuild: {
                description: "(deprecated) forces build to happen in the cloud",
                aliases: ["cloud", "cloud-build", "cb"]
            },
            localbuild: {
                description: "Build native image using local toolchains",
                aliases: ["local", "l", "local-build", "lb"]
            },
            force: {
                description: "skip cache lookup and force build",
                aliases: ["f"]
            },
            hwvariant: {
                description: "specify Hardware variant used for this compilation",
                argument: "hwvariant",
                type: "string",
                aliases: ["hw"]
            },
            install: {
                description: "install any missing package before build",
                aliases: ["i"]
            }
        },
        onlineHelp: true
    }, deployAsync)
    simpleCmd("run", "build and run current package in the simulator", runAsync);
    simpleCmd("console", "monitor console messages", consoleAsync, null, true);
    simpleCmd("update", "update pxt-core reference and install updated version", updateAsync, undefined, true);
    simpleCmd("add", "add a feature (.asm, C++ etc) to package", addAsync, "<arguments>");

    p.defineCommand({
        name: "install",
        help: "install dependencies",
        argString: "[package]",
        aliases: ["i"],
        onlineHelp: true,
        flags: {
            hwvariant: {
                description: "specify hardware variant",
                argument: "hwvariant",
                type: "string",
                aliases: ["hw"]
            }
        }
    }, installAsync);

    p.defineCommand({
        name: "bump",
        help: "bump target or package version",
        onlineHelp: true,
        flags: {
            update: { description: "(package only) Updates pxt-core reference to the latest release" },
            upload: { description: "(package only) Upload after bumping" }
        }
    }, bumpAsync);

    p.defineCommand({
        name: "tag",
        help: "tags a release",
        argString: "<tag> <version>",
        flags: {
            npm: { description: "updates tags on npm packages as well" }
        }
    }, tagReleaseAsync);

    p.defineCommand({
        name: "build",
        help: "builds current package",
        onlineHelp: true,
        flags: {
            cloudbuild: {
                description: "(deprecated) forces build to happen in the cloud",
                aliases: ["cloud", "cloud-build", "cb"]
            },
            localbuild: {
                description: "Build native image using local toolchains",
                aliases: ["local", "l", "local-build", "lb"]
            },
            force: {
                description: "skip cache lookup and force build",
                aliases: ["f"]
            },
            hwvariant: {
                description: "specify Hardware variant used for this compilation",
                argument: "hwvariant",
                type: "string",
                aliases: ["hw"]
            },
            debug: { description: "Emit debug information with build" },
            deploy: { description: "Deploy to device if connected" },
            warndiv: { description: "Warns about division operators" },
            ignoreTests: { description: "Ignores tests in compilation", aliases: ["ignore-tests", "ignoretests", "it"] },
            clean: { description: "Clean before build" },
            install: {
                description: "install any missing package before build",
                aliases: ["i"]
            }
        }
    }, buildAsync);

    simpleCmd("clean", "removes built folders", cleanAsync);
    advancedCommand("cleangen", "remove generated files", cleanGenAsync);
    simpleCmd("npminstallnative", "install native dependencies", npmInstallNativeAsync);

    p.defineCommand({
        name: "staticpkg",
        help: "packages the target into static HTML pages",
        onlineHelp: true,
        flags: {
            route: {
                description: "route appended to generated files",
                argument: "route",
                type: "string",
                aliases: ["r"]
            },
            githubpages: {
                description: "Generate a web site compatible with GitHub pages",
                aliases: ["ghpages", "gh"]
            },
            output: {
                description: "Specifies the output folder for the generated files",
                argument: "output",
                aliases: ["o"]
            },
            minify: {
                description: "minify all generated js files",
                aliases: ["m", "uglify"]
            },
            bump: {
                description: "bump version number prior to package"
            },
            cloudbuild: {
                description: "(deprecated) forces build to happen in the cloud",
                aliases: ["cloud", "cloud-build", "cb"]
            },
            localbuild: {
                description: "Build native image using local toolchains",
                aliases: ["local", "l", "local-build", "lb"]
            },
            locs: {
                description: "Download localization files and bundle them",
                aliases: ["locales", "crowdin"]
            },
            "no-appcache": {
                description: "Disables application cache"
            }
        }
    }, staticpkgAsync);

    p.defineCommand({
        name: "extract",
        help: "extract sources from .hex file, folder of .hex files, stdin (-), or URL",
        argString: "<path>",
        flags: {
            code: { description: "generate vscode project files" },
            out: {
                description: "directory to extract the project into",
                argument: "DIRNAME"
            }
        }
    }, extractAsync);

    p.defineCommand({
        name: "serve",
        help: "start web server for your local target",
        flags: {
            browser: {
                description: "set the browser to launch on web server start",
                argument: "name",
                possibleValues: ["chrome", "ie", "firefox", "safari"]
            },
            noBrowser: {
                description: "start the server without launching a browser",
                aliases: ["no-browser", "nb"]
            },
            noSerial: {
                description: "do not monitor serial devices",
                aliases: ["no-serial", "nos"]
            },
            sourceMaps: {
                description: "include source maps when building ts files",
                aliases: ["include-source-maps"]
            },
            pkg: { description: "serve packaged" },
            cloudbuild: {
                description: "(deprecated) forces build to happen in the cloud",
                aliases: ["cloud", "cloud-build", "cb"]
            },
            localbuild: {
                description: "Build native image using local toolchains",
                aliases: ["local", "l", "local-build", "lb"]
            },
            just: { description: "just serve without building" },
            rebundle: { description: "rebundle when change is detected", aliases: ["rb"] },
            hostname: {
                description: "hostname to run serve, default localhost",
                aliases: ["h"],
                type: "string",
                argument: "hostname"
            },
            port: {
                description: "port to bind server, default 3232",
                aliases: ["p"],
                type: "number",
                argument: "port"
            },
            wsport: {
                description: "port to bind websocket server, default 3233",
                aliases: ["w"],
                type: "number",
                argument: "wsport"
            }
        }
    }, serveAsync);

    p.defineCommand({
        name: "buildjres",
        aliases: ["jres"],
        help: "embeds resources into jres files"
    }, buildJResAsync);

    p.defineCommand({
        name: "buildsprites",
        help: "collects sprites into a .jres file",
        argString: "<directory>",
    }, buildJResSpritesAsync);

    p.defineCommand({
        name: "init",
        help: "start new package (library) in current directory",
        flags: {
            useDefaults: { description: "Do not prompt for package information" },
        }
    }, initAsync)

    // Hidden commands
    advancedCommand("test", "run tests on current package", testAsync);
    advancedCommand("testassembler", "test the assemblers", testAssemblers);
    advancedCommand("testdir", "compile files in directory one by one", testDirAsync, "<dir>");
    advancedCommand("testpkgconflicts", "tests package conflict detection logic", testPkgConflictsAsync);
    advancedCommand("testdbg", "tests hardware debugger", dbgTestAsync);

    p.defineCommand({
        name: "buildtarget",
        aliases: ["buildtrg", "bt", "build-target", "buildtrg"],
        advanced: true,
        help: "Builds the current target",
        flags: {
            cloudbuild: {
                description: "(deprecated) forces build to happen in the cloud",
                aliases: ["cloud", "cloud-build", "cb"]
            },
            localbuild: {
                description: "Build native image using local toolchains",
                aliases: ["local", "l", "local-build", "lb"]
            },
            force: {
                description: "skip cache lookup and force build",
                aliases: ["f"]
            },
            skipCore: {
                description: "skip native build of core packages",
                aliases: ["skip-core", "skipcore", "sc"]
            },
            clean: {
                description: "clean build before building"
            }
        }
    }, buildTargetAsync);
    p.defineCommand({
        name: "uploadtarget",
        aliases: ["uploadtrg", "ut", "upload-target", "upload-trg"],
        help: "Upload target release",
        argString: "<label>",
        advanced: true,
        flags: {
            cloudbuild: {
                description: "(deprecated) forces build to happen in the cloud",
                aliases: ["cloud", "cloud-build", "cb"]
            },
            localbuild: {
                description: "Build native image using local toolchains",
                aliases: ["local", "l", "local-build", "lb"]
            },
            force: {
                description: "skip cache lookup and force build",
                aliases: ["f"]
            },
            rebundle: {
                description: "skip build and just rebundle",
            }
        }
    }, uploadTargetReleaseAsync);
    p.defineCommand({
        name: "uploadrefs",
        aliases: [],
        help: "Upload refs directly to the cloud",
        argString: "<repo>",
        advanced: true,
    }, pc => uploadTargetRefsAsync(pc.args[0]));
    advancedCommand("uploadtt", "upload tagged release", uploadTaggedTargetAsync, "");
    advancedCommand("downloadtrgtranslations", "download translations from bundled projects", crowdin.downloadTargetTranslationsAsync, "<package>");

    p.defineCommand({
        name: "checkdocs",
        onlineHelp: true,
        help: "check docs for broken links, typing errors, etc...",
        flags: {
            snippets: { description: "(obsolete) compile snippets", deprecated: true },
            re: {
                description: "regular expression that matches the snippets to test",
                argument: "regex"
            },
            fix: {
                description: "Fix links if possible"
            },
            pycheck: {
                description: "Check code snippets by round-tripping to .py and comparing the "
                    + "original and result .ts. This will generate lots of false positives but can "
                    + "still be useful for searching for semantic issues."
            }
        }
    }, checkDocsAsync);

    advancedCommand("api", "do authenticated API call", pc => apiAsync(pc.args[0], pc.args[1]), "<path> [data]");
    advancedCommand("pokecloud", "same as 'api pokecloud {}'", () => apiAsync("pokecloud", "{}"));
    p.defineCommand({
        name: "ci",
        help: "run automated build in a continuous integration environment",
        aliases: ["travis", "githubactions", "buildci"]
    }, ciAsync);
    advancedCommand("uploadfile", "upload file under <CDN>/files/PATH", uploadFileAsync, "<path>");
    advancedCommand("service", "simulate a query to web worker", serviceAsync, "<operation>");
    advancedCommand("time", "measure performance of the compiler on the current package", timeAsync);

    p.defineCommand({
        name: "buildcss",
        help: "build required css files",
        flags: {
            force: {
                description: "force re-compile of less files"
            }
        }
    }, buildSemanticUIAsync);

    advancedCommand("augmentdocs", "test markdown docs replacements", augmnetDocsAsync, "<temlate.md> <doc.md>");

    advancedCommand("crowdin", "upload, download, clean, stats files to/from crowdin", pc => crowdin.execCrowdinAsync.apply(undefined, pc.args), "<cmd> <path> [output]")

    advancedCommand("hidlist", "list HID devices", hid.listAsync)
    advancedCommand("hidserial", "run HID serial forwarding", hid.serialAsync, undefined, true);
    advancedCommand("hiddmesg", "fetch DMESG buffer over HID and print it", hid.dmesgAsync, undefined, true);
    advancedCommand("hexdump", "dump UF2 or BIN file", hexdumpAsync, "<filename>")
    advancedCommand("hex2uf2", "convert .hex file to UF2", hex2uf2Async, "<filename>")
    p.defineCommand({
        name: "pyconv",
        help: "convert from python",
        argString: "<package-directory> <support-directory>...",
        advanced: true,
        flags: {
            internal: {
                description: "use internal Python parser",
                aliases: ["i"]
            }
        }
    }, c => pyconv.convertAsync(c.args, !!c.flags["internal"]))

    advancedCommand("thirdpartynotices", "refresh third party notices", thirdPartyNoticesAsync);
    p.defineCommand({
        name: "cherrypick",
        aliases: ["cp"],
        help: "recursively cherrypicks and push branches",
        argString: "<commit>",
        advanced: true,
        flags: {
            "name": {
                description: "name of the branch",
                type: "string",
                argument: "name"
            }
        }
    }, cherryPickAsync);

    p.defineCommand({
        name: "decompile",
        help: "decompile typescript files",
        argString: "<file1.ts> <file2.ts> ...",
        advanced: true,
        flags: {
            dep: { description: "include specified path as a dependency to the project", type: "string", argument: "path" }
        }
    }, decompileAsync);

    p.defineCommand({
        name: "gdb",
        help: "attempt to start openocd and GDB",
        argString: "[GDB_ARGUMNETS...]",
        anyArgs: true,
        advanced: true,
        onlineHelp: true
    }, gdbAsync);

    p.defineCommand({
        name: "hw",
        help: "apply hardware operation (via BMP)",
        argString: "reset|boot",
        anyArgs: true,
        advanced: true,
    }, hwAsync);

    p.defineCommand({
        name: "dmesg",
        help: "attempt to dump DMESG log using openocd",
        argString: "",
        aliases: ["dumplog"],
        advanced: true,
    }, dumplogAsync);

    p.defineCommand({
        name: "heap",
        help: "attempt to dump GC and codal heap log using openocd",
        argString: "[<memdump-file.bin>]",
        aliases: ["dumpheap"],
        advanced: true,
    }, dumpheapAsync);

    p.defineCommand({
        name: "memdump",
        help: "attempt to dump raw memory image using openocd",
        argString: "<memdump-file.bin>",
        aliases: ["dumpmem"],
        advanced: true,
    }, dumpmemAsync);

    p.defineCommand({
        name: "builddaldts",
        help: "build dal.d.ts in current directory or target (might be generated in a separate folder)",
        advanced: true,
        aliases: ["daldts"],
        flags: {
            clean: { description: "clean and build" }
        }
    }, buildDalDTSAsync);

    p.defineCommand({
        name: "rebundle",
        help: "update packages embedded in target.json (quick version of 'pxt bt')",
        advanced: true
    }, rebundleAsync);

    p.defineCommand({
        name: "pokerepo",
        help: "refresh repo, or generate a URL to do so",
        argString: "<repo>",
        flags: {
            u: { description: "" }
        },
        advanced: true
    }, pokeRepoAsync);

    p.defineCommand({
        name: "uploadtrgtranslations",
        help: "upload translations for target",
        flags: {
            apis: { description: "upload api strings" },
            docs: { description: "upload markdown docs folder as well" },
            test: { description: "test run, do not upload files to crowdin" }
        },
        advanced: true
    }, crowdin.uploadTargetTranslationsAsync);

    p.defineCommand({
        name: "format",
        help: " pretty-print TS files",
        argString: "<file1.ts> <file2.ts> ...",
        flags: {
            i: { description: "format files in-place" },
            t: { description: "test formatting" }
        },
        advanced: true
    }, formatAsync);

    p.defineCommand({
        name: "gendocs",
        help: "build current package and its docs",
        flags: {
            docs: { description: "produce docs files", aliases: ["doc"] },
            locs: { description: "produce localization files", aliases: ["loc"] },
            files: { description: "file name filter (regex)", type: "string", argument: "files" },
            create: { description: "only write new files" }
        },
        advanced: true
    }, gendocsAsync);

    p.defineCommand({
        name: "testghpkgs",
        help: "Download and build approved github packages",
        flags: {
            warndiv: { description: "Warns about division operators" },
            cloudbuild: {
                description: "(deprecated) forces build to happen in the cloud",
                aliases: ["cloud", "cloud-build", "cb"]
            },
            localbuild: {
                description: "Build native image using local toolchains",
                aliases: ["local", "l", "local-build", "lb"]
            },
            clean: { description: "delete all previous repos" }
        }
    }, testGithubPackagesAsync);

    p.defineCommand({
        name: "testblocks",
        help: "Test blocks files in target and common libs in a browser. See https://makecode.com/develop/blockstests",
        advanced: true,
        flags: {
            debug: { description: "Keeps the browser open to debug tests" }
        }
    }, blockTestsAsync);

    p.defineCommand({
        name: "exportcpp",
        help: "Export all generated C++ files to given directory",
        advanced: true,
        argString: "<target-directory>"
    }, exportCppAsync);

    function simpleCmd(name: string, help: string, callback: (c?: commandParser.ParsedCommand) => Promise<void>, argString?: string, onlineHelp?: boolean): void {
        p.defineCommand({ name, help, onlineHelp, argString }, callback);
    }

    function advancedCommand(name: string, help: string, callback: (c?: commandParser.ParsedCommand) => Promise<void>, argString?: string, onlineHelp = false) {
        p.defineCommand({ name, help, onlineHelp, argString, advanced: true }, callback);
    }
}

function handleCommandAsync(args: string[], preApply = () => Promise.resolve()) {
    return preApply().then(() => p.parseCommand(args))
}

function goToPkgDir() {
    let goUp = (s: string): string => {
        if (fs.existsSync(s + "/" + pxt.CONFIG_NAME)) {
            return s
        }
        let s2 = path.resolve(path.join(s, ".."))
        if (s != s2) {
            return goUp(s2)
        }
        return null
    }
    let dir = goUp(process.cwd())
    if (!dir) {
        console.error(`Cannot find ${pxt.CONFIG_NAME} in any of the parent directories.`)
        console.error(`Are you in a package directory?`)
        process.exit(1)
    } else {
        if (dir != process.cwd()) {
            console.log(`Going up to ${dir} which has ${pxt.CONFIG_NAME}`)
            process.chdir(dir)
        }
    }
}

function ensurePkgDir() {
    goToPkgDir();
}

function loadPkgAsync() {
    ensurePkgDir();
    return mainPkg.loadAsync()
}

function errorHandler(reason: any) {
    if (reason.isUserError) {
        if (pxt.options.debug)
            console.error(reason.stack)
        console.error("error:", reason.message)
        process.exit(1)
    }

    if (!Cloud.accessToken && reason.statusCode == 403) {
        console.error("Got HTTP 403. Did you forget to 'pxt login' ?")
        process.exit(1)
    }

    let msg = reason.stack || reason.message || (reason + "")
    console.error("INTERNAL ERROR:", msg)
    process.exit(20)
}

let cachedSimDir: string = "";
function simDir() {
    const dirSim = "sim";
    const npmSim = `node_modules/pxt-${pxt.appTarget.id}-sim`;
    if (!cachedSimDir) {
        if (nodeutil.existsDirSync(dirSim) && fs.existsSync(path.join(dirSim, "tsconfig.json"))) {
            cachedSimDir = dirSim;
        } else if (fs.existsSync(npmSim) && fs.existsSync(path.join(npmSim, "tsconfig.json"))) {
            cachedSimDir = npmSim;
        }
    }

    return cachedSimDir;
}

// called from pxt npm package
export function mainCli(targetDir: string, args: string[] = process.argv.slice(2)): Promise<void> {
    process.on("unhandledRejection", errorHandler);
    process.on('uncaughtException', errorHandler);

    if (!targetDir) {
        console.error("Please upgrade your pxt CLI module.")
        console.error("   npm update -g pxt")
        process.exit(30)
        return Promise.resolve();
    }

    nodeutil.setTargetDir(targetDir);

    let trg = nodeutil.getPxtTarget()
    fillInCompilerExtension(trg)
    pxt.setAppTarget(trg)

    pxt.setCompileSwitches(process.env["PXT_COMPILE_SWITCHES"])

    let compileId = "none"
    if (trg.compileService) {
        compileId = trg.compileService.buildEngine || "yotta"
    }

    const versions = pxt.appTarget.versions || ({ target: "", pxt: "" } as pxt.TargetVersions);
    pxt.log(`Using target ${trg.id} with build engine ${compileId}`)
    pxt.log(`  target: v${versions.target} ${nodeutil.targetDir}`)
    pxt.log(`  pxt-core: v${versions.pxt} ${nodeutil.pxtCoreDir}`)

    pxt.HF2.enableLog()

    if (compileId != "none") {
        build.setThisBuild(build.buildEngines[compileId]);
        if (!build.thisBuild) U.userError("cannot find build engine: " + compileId)
    }

    if (process.env["PXT_DEBUG"]) {
        pxt.options.debug = true;
        pxt.debug = pxt.log;
    }

    if (process.env["PXT_ASMDEBUG"]) {
        ts.pxtc.assembler.debug = true
    }

    commonfiles = readJson(__dirname + "/pxt-common.json")

    return initConfigAsync()
        .then(() => {

            if (args[0] != "buildtarget") {
                initTargetCommands();
            }

            if (!pxt.commands.deployFallbackAsync && build.thisBuild.deployAsync)
                pxt.commands.deployFallbackAsync = build.thisBuild.deployAsync

            if (!args[0]) {
                if (pxt.commands.deployFallbackAsync) {
                    pxt.log("running 'pxt deploy' (run 'pxt help' for usage)")
                    args = ["deploy"]
                } else {
                    pxt.log("running 'pxt build' (run 'pxt help' for usage)")
                    args = ["build"]
                }
            }

            return p.parseCommand(args)
                .then(() => {
                    if (readlineCount)
                        (process.stdin as any).unref();
                    return nodeutil.runCliFinalizersAsync()
                });
        });
}

function initGlobals() {
    let g = global as any
    g.pxt = pxt;
    g.ts = ts;
    g.pxtc = pxtc;
}

initGlobals();
initCommands();

if (require.main === module) {
    let targetdir = process.cwd()
    while (true) {
        if (fs.existsSync(targetdir + "/pxtarget.json")) break;
        let newone = path.resolve(targetdir + "/..")
        if (newone == targetdir) {
            targetdir = path.resolve(path.join(__dirname, "../../.."))
            break
        } else {
            targetdir = newone
        }
    }
    if (!fs.existsSync(targetdir + "/pxtarget.json")) {
        targetdir = path.resolve(path.join(__dirname, ".."))
        if (!fs.existsSync(targetdir + "/pxtarget.json")) {
            console.error("Cannot find pxtarget.json")
            process.exit(1)
        }
    }
    mainCli(targetdir).done();
}
