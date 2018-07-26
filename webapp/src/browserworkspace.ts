import * as db from "./db";

let headers: db.Table;
let texts: db.Table;

type Header = pxt.workspace.Header;
type ScriptText = pxt.workspace.ScriptText;
type WorkspaceProvider = pxt.workspace.WorkspaceProvider;

let initPromise: Promise<void>;

function initAsync(): Promise<void> {
    if (!initPromise) {
        const currentVersion = pxt.semver.parse(pxt.appTarget.versions.target);
        const currentMajor = currentVersion.major;
        const currentDbPrefix = pxt.appTarget.appTheme.browserDbPrefixes && pxt.appTarget.appTheme.browserDbPrefixes[currentMajor];

        if (!currentDbPrefix) {
            // This version does not use a prefix for storing projects, so just use default tables
            headers = new db.Table("header");
            texts = new db.Table("text");
            initPromise = Promise.resolve();
            return initPromise;
        }

        headers = new db.Table(`${currentDbPrefix}-header`);
        texts = new db.Table(`${currentDbPrefix}-text`);

        initPromise = headers.getAllAsync()
            .then((allDbHeaders) => {
                if (allDbHeaders.length) {
                    // There are already scripts using the prefix, so a migration has already happened
                    return Promise.resolve();
                }

                // No headers using this prefix yet, attempt to migrate headers from previous major version (or default tables)
                const previousMajor = currentMajor - 1;
                const previousDbPrefix = previousMajor < 0 ? "" : pxt.appTarget.appTheme.browserDbPrefixes && pxt.appTarget.appTheme.browserDbPrefixes[previousMajor];
                let previousHeaders = new db.Table("header");
                let previousTexts = new db.Table("text");

                if (previousDbPrefix) {
                    previousHeaders = new db.Table(`${previousDbPrefix}-header`);
                    previousTexts = new db.Table(`${previousDbPrefix}-text`);
                }

                const copyProject = (h: pxt.workspace.Header): Promise<string> => {
                    return previousTexts.getAsync(h.id)
                        .then((resp) => setAsync(h, undefined, resp.files, /* skipInit */ true)); // undefined _rev because it's a new document
                };

                return previousHeaders.getAllAsync()
                    .then((previousHeaders: pxt.workspace.Header[]) => {
                        return Promise.map(previousHeaders, (h) => copyProject(h));
                    })
                    .then(() => { });
            });
    }

    return initPromise;
}

function listAsync(): Promise<pxt.workspace.Header[]> {
    return initAsync()
        .then(() => headers.getAllAsync());
}

function getAsync(h: Header): Promise<pxt.workspace.File> {
    return initAsync()
        .then(() => texts.getAsync(h.id))
        .then(resp => ({
            header: h,
            text: resp.files,
            version: resp._rev
        }));
}

function setAsync(h: Header, prevVer: any, text?: ScriptText, skipInit?: boolean) {
    let retrev = ""
    return (skipInit ? Promise.resolve() : initAsync())
        .then(() => (!text ? Promise.resolve() :
            texts.setAsync({
                id: h.id,
                files: text,
                _rev: prevVer
            }).then(rev => {
                retrev = rev
            })))
        .then(() => headers.setAsync(h))
        .then(rev => {
            h._rev = rev
            return retrev
        });
}

function deleteAsync(h: Header, prevVer: any) {
    return initAsync()
        .then(() => headers.deleteAsync(h))
        .then(() => texts.deleteAsync({ id: h.id, _rev: h._rev }));
}

function resetAsync() {
    // workspace.resetAsync already clears all tables
    return Promise.resolve();
}

export const provider: WorkspaceProvider = {
    getAsync,
    setAsync,
    deleteAsync,
    listAsync,
    resetAsync,
}