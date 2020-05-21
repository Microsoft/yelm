namespace pxt.BrowserUtils {

    export function isIFrame(): boolean {
        try {
            return window && window.self !== window.top;
        } catch (e) {
            return true;
        }
    }

    export function hasNavigator(): boolean {
        return typeof navigator !== "undefined";
    }

    export function isWindows(): boolean {
        return hasNavigator() && /(Win32|Win64|WOW64)/i.test(navigator.platform);
    }

    export function isWindows10(): boolean {
        return hasNavigator() && /(Win32|Win64|WOW64)/i.test(navigator.platform) && /Windows NT 10/i.test(navigator.userAgent);
    }

    export function isMobile(): boolean {
        return hasNavigator() && /mobi/i.test(navigator.userAgent);
    }

    export function isIOS(): boolean {
        return (hasNavigator() && /iPad|iPhone|iPod/.test(navigator.userAgent))
            || (/iPad|iPhone|iPod/.test(navigator.platform) // fails on iPad iOS13 webview
                || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !window.hasOwnProperty('MSStream'); // therefore we check for MacIntel platform with multiple touch and make sure its not an IE.
    }

    //MacIntel on modern Macs
    export function isMac(): boolean {
        return hasNavigator() && /Mac/i.test(navigator.platform);
    }

    //This is generally appears for Linux
    //Android *sometimes* returns this
    export function isLinux(): boolean {
        return !!navigator && /Linux/i.test(navigator.platform);
    }

    // Detects if we are running on ARM (Raspberry pi)
    export function isARM(): boolean {
        return hasNavigator() && /arm/i.test(navigator.platform);
    }

    // Detects if we are running inside the UWP runtime (Microsoft Edge)
    export function isUwpEdge(): boolean {
        return typeof window !== "undefined" && !!(<any>window).Windows;
    }

    /*
    Notes on browser detection

    Actually:             Claims to be:
                          IE  MicrosoftEdge    Chrome  Safari  Firefox
              IE          X                           X?
    Microsoft Edge                    X       X       X
              Chrome                          X       X
              Safari                                  X       X
              Firefox                                         X

    I allow Opera to go about claiming to be Chrome because it might as well be
    */

    //Microsoft Edge lies about its user agent and claims to be Chrome, but Microsoft Edge/Version
    //is always at the end
    export function isEdge(): boolean {
        return hasNavigator() && /Edge/i.test(navigator.userAgent);
    }

    //IE11 also lies about its user agent, but has Trident appear somewhere in
    //the user agent. Detecting the different between IE11 and Microsoft Edge isn't
    //super-important because the UI is similar enough
    export function isIE(): boolean {
        return hasNavigator() && /Trident/i.test(navigator.userAgent);
    }

    //Microsoft Edge and IE11 lie about being Chrome
    export function isChrome(): boolean {
        return !isEdge() && !isIE() && !!navigator && (/Chrome/i.test(navigator.userAgent) || /Chromium/i.test(navigator.userAgent));
    }

    //Chrome and Microsoft Edge lie about being Safari
    export function isSafari(): boolean {
        //Could also check isMac but I don't want to risk excluding iOS
        //Checking for iPhone, iPod or iPad as well as Safari in order to detect home screen browsers on iOS
        return !isChrome() && !isEdge() && !!navigator && /(Macintosh|Safari|iPod|iPhone|iPad)/i.test(navigator.userAgent)
            || (((navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !window.hasOwnProperty('MSStream')); // iPad  with IOS > 13
    }

    //Safari and WebKit lie about being Firefox
    export function isFirefox(): boolean {
        return !isSafari() && !!navigator && (/Firefox/i.test(navigator.userAgent) || /Seamonkey/i.test(navigator.userAgent));
    }

    //These days Opera's core is based on Chromium so we shouldn't distinguish between them too much
    export function isOpera(): boolean {
        return hasNavigator() && /Opera|OPR/i.test(navigator.userAgent);
    }

    //Midori *was* the default browser on Raspbian, however isn't any more
    export function isMidori(): boolean {
        return hasNavigator() && /Midori/i.test(navigator.userAgent);
    }

    //Epiphany (code name for GNOME Web) is the default browser on Raspberry Pi
    //Epiphany also lies about being Chrome, Safari, and Chromium
    export function isEpiphany(): boolean {
        return hasNavigator() && /Epiphany/i.test(navigator.userAgent);
    }

    export function isTouchEnabled(): boolean {
        return typeof window !== "undefined" &&
            ('ontouchstart' in window                              // works on most browsers
                || (navigator && navigator.maxTouchPoints > 0));       // works on IE10/11 and Surface);
    }

    export function isPxtElectron(): boolean {
        return typeof window != "undefined" && !!(window as any).pxtElectron;
    }

    export function isIpcRenderer(): boolean {
        return typeof window != "undefined" && !!(window as any).ipcRenderer;
    }
    export function isElectron() {
        return isPxtElectron() || isIpcRenderer();
    }

    export function isLocalHost(ignoreFlags?: boolean): boolean {
        try {
            return typeof window !== "undefined"
                && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(window.location.href)
                && (ignoreFlags || !/nolocalhost=1/.test(window.location.href))
                && !(pxt?.webConfig?.isStatic);
        } catch (e) { return false; }
    }

    export function isLocalHostDev(): boolean {
        return isLocalHost() && !isElectron();
    }

    export function hasPointerEvents(): boolean {
        return typeof window != "undefined" && !!(window as any).PointerEvent;
    }

    export function hasSaveAs(): boolean {
        return isEdge() || isIE() || isFirefox();
    }

    export function os(): string {
        if (isWindows()) return "windows";
        else if (isMac()) return "mac";
        else if (isLinux() && isARM()) return "rpi";
        else if (isLinux()) return "linux";
        else return "unknown";
    }

    export function browser(): string {
        if (isEdge()) return "edge";
        if (isEpiphany()) return "epiphany";
        else if (isMidori()) return "midori";
        else if (isOpera()) return "opera";
        else if (isIE()) return "ie";
        else if (isChrome()) return "chrome";
        else if (isSafari()) return "safari";
        else if (isFirefox()) return "firefox";
        else return "unknown";
    }

    export function browserVersion(): string {
        if (!hasNavigator()) return null;
        //Unsurprisingly browsers also lie about this and include other browser versions...
        let matches: string[] = [];
        if (isOpera()) {
            matches = /(Opera|OPR)\/([0-9\.]+)/i.exec(navigator.userAgent);
        }
        if (isEpiphany()) {
            matches = /Epiphany\/([0-9\.]+)/i.exec(navigator.userAgent);
        }
        else if (isMidori()) {
            matches = /Midori\/([0-9\.]+)/i.exec(navigator.userAgent);
        }
        else if (isSafari()) {
            matches = /Version\/([0-9\.]+)/i.exec(navigator.userAgent);
            // pinned web sites and WKWebview for embedded browsers have a different user agent
            // Mozilla/5.0 (iPhone; CPU iPhone OS 10_2_1 like Mac OS X) AppleWebKit/602.4.6 (KHTML, like Gecko) Mobile/14D27
            // Mozilla/5.0 (iPad; CPU OS 10_3_3 like Mac OS X) AppleWebKit/603.3.8 (KHTML, like Gecko) Mobile/14G60
            // Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_5) AppleWebKit/605.1.15 (KHTML, like Gecko)
            if (!matches)
                matches = /(Macintosh|iPod|iPhone|iPad); (CPU|Intel).*?OS (X )?(\d+)/i.exec(navigator.userAgent);
        }
        else if (isChrome()) {
            matches = /(Chrome|Chromium)\/([0-9\.]+)/i.exec(navigator.userAgent);
        }
        else if (isEdge()) {
            matches = /Edge\/([0-9\.]+)/i.exec(navigator.userAgent);
        }
        else if (isIE()) {
            matches = /(MSIE |rv:)([0-9\.]+)/i.exec(navigator.userAgent);
        }
        else {
            matches = /(Firefox|Seamonkey)\/([0-9\.]+)/i.exec(navigator.userAgent);
        }
        if (!matches || matches.length == 0) {
            return null;
        }
        return matches[matches.length - 1];
    }

    let hasLoggedBrowser = false

    // Note that IE11 is no longer supported in any target. Redirect handled in docfiles/pxtweb/browserRedirect.ts
    export function isBrowserSupported(): boolean {
        if (!navigator) {
            return true; //All browsers define this, but we can't make any predictions if it isn't defined, so assume the best
        }

        // allow bots in general
        if (/bot|crawler|spider|crawling/i.test(navigator.userAgent))
            return true;

        // Check target theme to see if this browser is supported
        const unsupportedBrowsers = pxt.appTarget?.unsupportedBrowsers
            || (window as any).pxtTargetBundle?.unsupportedBrowsers as BrowserOptions[];
        if (unsupportedBrowsers?.some(b => b.id == browser())) {
            return false
        }

        // testing browser versions
        const versionString = browserVersion();
        const v = parseInt(versionString || "0")

        const isRecentChrome = isChrome() && v >= 38;
        const isRecentFirefox = isFirefox() && v >= 31;
        const isRecentEdge = isEdge();
        const isRecentSafari = isSafari() && v >= 9;
        const isRecentOpera = (isOpera() && isChrome()) && v >= 21;
        const isModernBrowser = isRecentChrome || isRecentFirefox || isRecentEdge || isRecentSafari || isRecentOpera

        //In the future this should check for the availability of features, such
        //as web workers
        let isSupported = isModernBrowser

        const isUnsupportedRPI = isMidori() || (isLinux() && isARM() && isEpiphany());
        const isNotSupported = isUnsupportedRPI;

        isSupported = isSupported && !isNotSupported

        //Bypass
        isSupported = isSupported || /anybrowser=(true|1)/.test(window.location.href)

        if (!hasLoggedBrowser) {
            pxt.log(`Browser: ${browser()} ${versionString} on ${os()}`)
            if (!isSupported) {
                pxt.tickEvent("browser.unsupported", { useragent: navigator.userAgent })
            }
            hasLoggedBrowser = true
        }
        return isSupported
    }

    export function devicePixelRatio(): number {
        if (typeof window === "undefined" || !window.screen) return 1;

        // these are IE specific
        const sysXDPI = (window.screen as any).systemXDPI
        const logicalXDPI = (window.screen as any).logicalXDPI
        if (sysXDPI !== undefined
            && logicalXDPI !== undefined
            && sysXDPI > logicalXDPI) {
            return sysXDPI / logicalXDPI;
        }
        else if (window && window.devicePixelRatio !== undefined) {
            return window.devicePixelRatio;
        }
        return 1;
    }

    export function browserDownloadBinText(text: string, name: string, contentType: string = "application/octet-stream", userContextWindow?: Window, onError?: (err: any) => void): string {
        return browserDownloadBase64(ts.pxtc.encodeBase64(text), name, contentType, userContextWindow, onError)
    }

    export function browserDownloadText(text: string, name: string, contentType: string = "application/octet-stream", userContextWindow?: Window, onError?: (err: any) => void): string {
        return browserDownloadBase64(ts.pxtc.encodeBase64(Util.toUTF8(text)), name, contentType, userContextWindow, onError)
    }

    export function isBrowserDownloadInSameWindow(): boolean {
        const windowOpen = isMobile() && isSafari() && !/downloadWindowOpen=0/i.test(window.location.href);
        return windowOpen;
    }

    // for browsers that strictly require that a download gets initiated within a user click
    export function isBrowserDownloadWithinUserContext(): boolean {
        const versionString = browserVersion();
        const v = parseInt(versionString || "0")
        const r = (isMobile() && isSafari() && v >= 11) || /downloadUserContext=1/i.test(window.location.href);
        return r;
    }

    export function browserDownloadDataUri(uri: string, name: string, userContextWindow?: Window) {
        const windowOpen = isBrowserDownloadInSameWindow();
        const versionString = browserVersion();
        const v = parseInt(versionString || "0")
        if (windowOpen) {
            if (userContextWindow) userContextWindow.location.href = uri;
            else window.open(uri, "_self");
        } else if (pxt.BrowserUtils.isSafari()
            && (v < 10 || (versionString.indexOf('10.0') == 0) || isMobile())) {
            // For Safari versions prior to 10.1 and all Mobile Safari versions
            // For mysterious reasons, the "link" trick closes the
            // PouchDB database
            let iframe = document.getElementById("downloader") as HTMLIFrameElement;
            if (!iframe) {
                pxt.debug('injecting downloader iframe')
                iframe = document.createElement("iframe") as HTMLIFrameElement;
                iframe.id = "downloader";
                iframe.style.position = "absolute";
                iframe.style.right = "0";
                iframe.style.bottom = "0";
                iframe.style.zIndex = "-1";
                iframe.style.width = "1px";
                iframe.style.height = "1px";
                document.body.appendChild(iframe);
            }
            iframe.src = uri;
        } else if (pxt.BrowserUtils.isEdge() || pxt.BrowserUtils.isIE()) {
            //Fix for edge
            let byteString = atob(uri.split(',')[1]);
            let ia = Util.stringToUint8Array(byteString);
            let blob = new Blob([ia], { type: "img/png" });
            window.navigator.msSaveOrOpenBlob(blob, name);
        } else {
            let link = <any>window.document.createElement('a');
            if (typeof link.download == "string") {
                link.href = uri;
                link.download = name;
                document.body.appendChild(link); // for FF
                link.click();
                document.body.removeChild(link);
            } else {
                document.location.href = uri;
            }
        }
    }

    export function browserDownloadUInt8Array(buf: Uint8Array, name: string, contentType: string = "application/octet-stream", userContextWindow?: Window, onError?: (err: any) => void): string {
        return browserDownloadBase64(ts.pxtc.encodeBase64(Util.uint8ArrayToString(buf)), name, contentType, userContextWindow, onError)
    }

    export function toDownloadDataUri(b64: string, contentType: string): string {
        let protocol = "data";
        if (isMobile() && isSafari() && pxt.appTarget.appTheme.mobileSafariDownloadProtocol)
            protocol = pxt.appTarget.appTheme.mobileSafariDownloadProtocol;
        const m = /downloadProtocol=([a-z0-9:/?]+)/i.exec(window.location.href);
        if (m) protocol = m[1];
        const dataurl = protocol + ":" + contentType + ";base64," + b64
        return dataurl;
    }

    export function browserDownloadBase64(b64: string, name: string, contentType: string = "application/octet-stream", userContextWindow?: Window, onError?: (err: any) => void): string {
        pxt.debug('trigger download')

        const saveBlob = (<any>window).navigator.msSaveOrOpenBlob && !pxt.BrowserUtils.isMobile();
        const dataurl = toDownloadDataUri(b64, name);
        try {
            if (saveBlob) {
                const b = new Blob([Util.stringToUint8Array(atob(b64))], { type: contentType })
                const result = (<any>window).navigator.msSaveOrOpenBlob(b, name);
            } else browserDownloadDataUri(dataurl, name, userContextWindow);
        } catch (e) {
            if (onError) onError(e);
            pxt.debug("saving failed")
        }
        return dataurl;
    }

    export function loadImageAsync(data: string): Promise<HTMLImageElement> {
        const img = document.createElement("img")
        return new Promise<HTMLImageElement>((resolve, reject) => {
            img.onload = () => resolve(img);
            img.onerror = () => resolve(undefined);
            img.crossOrigin = "anonymous";
            img.src = data;
        });
    }

    export function loadCanvasAsync(url: string): Promise<HTMLCanvasElement> {
        return loadImageAsync(url)
            .then(img => {
                const canvas = document.createElement("canvas")
                canvas.width = img.width
                canvas.height = img.height
                const ctx = canvas.getContext("2d")
                ctx.drawImage(img, 0, 0);
                return canvas;
            })
    }

    export function imageDataToPNG(img: ImageData): string {
        if (!img) return undefined;

        const canvas = document.createElement("canvas")
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext("2d")
        ctx.putImageData(img, 0, 0);
        return canvas.toDataURL("image/png");
    }

    export function resolveCdnUrl(path: string): string {
        // don't expand full urls
        if (/^https?:\/\//i.test(path))
            return path;
        const monacoPaths: Map<string> = (window as any).MonacoPaths || {};
        const blobPath = monacoPaths[path];
        // find compute blob url
        if (blobPath)
            return blobPath;
        // might have been exanded already
        if (U.startsWith(path, pxt.webConfig.commitCdnUrl))
            return path;
        // append CDN
        return pxt.webConfig.commitCdnUrl + path;
    }

    export function loadStyleAsync(path: string, rtl?: boolean): Promise<void> {
        if (rtl) path = "rtl" + path;
        const id = "style-" + path;
        if (document.getElementById(id)) return Promise.resolve();

        const url = resolveCdnUrl(path);
        const links = Util.toArray(document.head.getElementsByTagName("link"));
        const link = links.filter(l => l.getAttribute("href") == url)[0];
        if (link) {
            if (!link.id) link.id = id;
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const el = document.createElement("link");
            el.href = url;
            el.rel = "stylesheet";
            el.type = "text/css";
            el.id = id;
            el.addEventListener('load', () => resolve());
            el.addEventListener('error', (e) => reject(e));
            document.head.appendChild(el);
        });
    }

    let loadScriptPromises: pxt.Map<Promise<void>> = {};
    export function loadScriptAsync(path: string): Promise<void> {
        const url = resolveCdnUrl(path);
        let p = loadScriptPromises[url];
        if (!p) {
            p = loadScriptPromises[url] = new Promise<void>((resolve, reject) => {
                pxt.debug(`script: loading ${url}`);
                const script = document.createElement('script');
                script.type = 'text/javascript';
                script.addEventListener('load', () => resolve());
                script.addEventListener('error', (e) => {
                    // might have had connection issue, allow to try later
                    delete loadScriptPromises[url];
                    reject(e);
                });
                script.src = url;
                script.async = true;
                document.body.appendChild(script);
            });
        }
        return p;
    }

    export function loadAjaxAsync(url: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            let httprequest = new XMLHttpRequest();
            httprequest.onreadystatechange = function () {
                if (httprequest.readyState == XMLHttpRequest.DONE) {
                    if (httprequest.status == 200) {
                        resolve(httprequest.responseText);
                    }
                    else {
                        reject(httprequest.status);
                    }
                }
            };
            httprequest.open("GET", url, true);
            httprequest.send();
        })
    }

    let loadBlocklyPromise: Promise<void>;
    export function loadBlocklyAsync(): Promise<void> {
        if (!loadBlocklyPromise) {
            pxt.debug(`blockly: delay load`);
            let p = pxt.BrowserUtils.loadStyleAsync("blockly.css", ts.pxtc.Util.isUserLanguageRtl());
            // js not loaded yet?
            if (typeof Blockly === "undefined")
                p = p.then(() => pxt.BrowserUtils.loadScriptAsync("pxtblockly.js"));
            p = p.then(() => {
                pxt.debug(`blockly: loaded`)
            });
            loadBlocklyPromise = p;
        }
        return loadBlocklyPromise;
    }

    export function patchCdn(url: string): string {
        if (!url) return url;
        const online = pxt.getOnlineCdnUrl();
        if (online)
            return url.replace("@cdnUrl@", online);
        else
            return url.replace(/@cdnUrl@\/(blob|commit)\/[a-f0-9]{40}\//, "./");
    }

    export function initTheme() {
        const theme = pxt.appTarget.appTheme;
        if (theme) {
            if (theme.accentColor) {
                let style = document.createElement('style');
                style.type = 'text/css';
                style.appendChild(document.createTextNode(
                    `.ui.accent { color: ${theme.accentColor}; }
                .ui.inverted.menu .accent.active.item, .ui.inverted.accent.menu  { background-color: ${theme.accentColor}; }`));
                document.getElementsByTagName('head')[0].appendChild(style);
            }
        }
        // RTL languages
        if (Util.isUserLanguageRtl()) {
            pxt.debug("rtl layout");
            pxt.BrowserUtils.addClass(document.body, "rtl");
            document.body.style.direction = "rtl";

            // replace semantic.css with rtlsemantic.css
            const links = Util.toArray(document.head.getElementsByTagName("link"));
            const semanticLink = links.filter(l => Util.endsWith(l.getAttribute("href"), "semantic.css"))[0];
            if (semanticLink) {
                const semanticHref = semanticLink.getAttribute("data-rtl");
                if (semanticHref) {
                    pxt.debug(`swapping to ${semanticHref}`)
                    semanticLink.setAttribute("href", semanticHref);
                }
            }
            // replace blockly.css with rtlblockly.css if possible
            const blocklyLink = links.filter(l => Util.endsWith(l.getAttribute("href"), "blockly.css"))[0];
            if (blocklyLink) {
                const blocklyHref = blocklyLink.getAttribute("data-rtl");
                if (blocklyHref) {
                    pxt.debug(`swapping to ${blocklyHref}`)
                    blocklyLink.setAttribute("href", blocklyHref);
                    blocklyLink.removeAttribute("data-rtl");
                }
            }
        }
    }

    /**
     * Utility method to change the hash.
     * Pass keepHistory to retain an entry of the change in the browser history.
     */
    export function changeHash(hash: string, keepHistory?: boolean) {
        if (hash.charAt(0) != '#') hash = '#' + hash;
        if (keepHistory) {
            window.location.hash = hash;
        } else {
            window.history.replaceState('', '', hash)
        }
    }

    /**
     * Simple utility method to join urls.
     */
    export function urlJoin(urlPath1: string, urlPath2: string): string {
        if (!urlPath1) return urlPath2;
        if (!urlPath2) return urlPath1;
        const normalizedUrl1 = (urlPath1.indexOf('/') == urlPath1.length - 1) ?
            urlPath1.substring(0, urlPath1.length - 1) : urlPath1;
        const normalizedUrl2 = (urlPath2.indexOf('/') == 0) ?
            urlPath2.substring(1) : urlPath2;
        return normalizedUrl1 + "/" + normalizedUrl2;
    }

    /**
     * Simple utility method to join multiple urls.
     */
    export function joinURLs(...parts: string[]): string {
        let result: string;
        if (parts) {
            for (let i = 0; i < parts.length; i++) {
                result = urlJoin(result, parts[i]);
            }
        }
        return result;
    }

    export function storageEstimateAsync(): Promise<{ quota?: number; usage?: number; }> {
        const nav = hasNavigator() && <any>window.navigator;
        if (nav && nav.storage && nav.storage.estimate)
            return nav.storage.estimate();
        else return Promise.resolve({});
    }

    export const scheduleStorageCleanup = hasNavigator() && (<any>navigator).storage && (<any>navigator).storage.estimate // some browser don't support this
        ? ts.pxtc.Util.throttle(function () {
            const MIN_QUOTA = 1000000; // 1Mb
            const MAX_USAGE_RATIO = 0.9; // max 90%

            storageEstimateAsync()
                .then(estimate => {
                    // quota > 50%
                    pxt.debug(`storage estimate: ${(estimate.usage / estimate.quota * 100) >> 0}%, ${(estimate.usage / 1000000) >> 0}/${(estimate.quota / 1000000) >> 0}Mb`)
                    if (estimate.quota
                        && estimate.usage
                        && estimate.quota > MIN_QUOTA
                        && (estimate.usage / estimate.quota) > MAX_USAGE_RATIO) {
                        pxt.log(`quota usage exceeded, clearing translations`);
                        pxt.tickEvent('storage.cleanup');
                        return clearTranslationDbAsync();
                    }
                    return Promise.resolve();
                })
                .catch(e => {
                    pxt.reportException(e);
                })
        }, 10000, false)
        : () => { };

    export function stressTranslationsAsync(): Promise<void> {
        let md = "...";
        for (let i = 0; i < 16; ++i)
            md += md + Math.random();
        console.log(`adding entry ${md.length * 2} bytes`);
        return Promise.delay(1)
            .then(() => translationDbAsync())
            .then(db => db.setAsync("foobar", Math.random().toString(), "", null, undefined, md))
            .then(() => pxt.BrowserUtils.storageEstimateAsync())
            .then(estimate => !estimate.quota || estimate.usage / estimate.quota < 0.8 ? stressTranslationsAsync() : Promise.resolve());
    }

    export interface ITranslationDbEntry {
        id?: string;
        etag: string;
        time: number;
        strings?: pxt.Map<string>; // UI string translations
        md?: string; // markdown content
    }

    export interface ITranslationDb {
        getAsync(lang: string, filename: string, branch: string): Promise<ITranslationDbEntry>;
        setAsync(lang: string, filename: string, branch: string, etag: string, strings?: pxt.Map<string>, md?: string): Promise<void>;
        // delete all
        clearAsync(): Promise<void>;
    }

    class MemTranslationDb implements ITranslationDb {
        translations: pxt.Map<ITranslationDbEntry> = {};
        key(lang: string, filename: string, branch: string) {
            return `${lang}|${filename}|${branch || "master"}`;
        }
        get(lang: string, filename: string, branch: string): ITranslationDbEntry {
            return this.translations[this.key(lang, filename, branch)];
        }
        getAsync(lang: string, filename: string, branch: string): Promise<ITranslationDbEntry> {
            return Promise.resolve(this.get(lang, filename, branch));
        }
        set(lang: string, filename: string, branch: string, etag: string, time: number, strings?: pxt.Map<string>, md?: string) {
            this.translations[this.key(lang, filename, branch)] = {
                etag,
                time,
                strings,
                md
            }
        }
        setAsync(lang: string, filename: string, branch: string, etag: string, strings?: pxt.Map<string>, md?: string): Promise<void> {
            this.set(lang, filename, branch, etag, Util.now(), strings);
            return Promise.resolve();
        }
        clearAsync() {
            this.translations = {};
            return Promise.resolve();
        }
    }

    // IndexedDB wrapper class
    export type IDBUpgradeHandler = (ev: IDBVersionChangeEvent, request: IDBRequest) => void;

    export class IDBWrapper {
        private _db: IDBDatabase;

        constructor(
            private name: string,
            private version: number,
            private upgradeHandler?: IDBUpgradeHandler,
            private quotaExceededHandler?: () => void) {
        }

        private throwIfNotOpened(): void {
            if (!this._db) {
                throw new Error("Database not opened; call IDBWrapper.openAsync() first");
            }
        }

        private errorHandler(err: Error, op: string, reject: (err: Error) => void): void {
            console.error(new Error(`${this.name} IDBWrapper error for ${op}: ${err.message}`));
            reject(err);
            // special case for quota exceeded
            if (err.name == "QuotaExceededError") {
                // oops, we ran out of space
                pxt.log(`storage quota exceeded...`);
                pxt.tickEvent('storage.quotaexceedederror');
                if (this.quotaExceededHandler)
                    this.quotaExceededHandler();
            }
        }

        private getObjectStore(name: string, mode: "readonly" | "readwrite" = "readonly"): IDBObjectStore {
            this.throwIfNotOpened();
            const transaction = this._db.transaction([name], mode);
            return transaction.objectStore(name);
        }

        static deleteDatabaseAsync(name: string): Promise<void> {
            return new Promise((resolve, reject) => {
                const idbFactory: IDBFactory = window.indexedDB || (<any>window).mozIndexedDB || (<any>window).webkitIndexedDB || (<any>window).msIndexedDB;
                const request = idbFactory.deleteDatabase(name);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        }

        public openAsync(): Promise<void> {
            return new Promise((resolve, reject) => {
                const idbFactory: IDBFactory = window.indexedDB || (<any>window).mozIndexedDB || (<any>window).webkitIndexedDB || (<any>window).msIndexedDB;
                const request = idbFactory.open(this.name, this.version);
                request.onsuccess = () => {
                    this._db = request.result;
                    resolve();
                };
                request.onerror = () => this.errorHandler(request.error, "open", reject);
                request.onupgradeneeded = (ev) => this.upgradeHandler(ev, request);
            });
        }

        public getAsync<T>(storeName: string, id: string): Promise<T> {
            return new Promise((resolve, reject) => {
                const store = this.getObjectStore(storeName);
                const request = store.get(id);
                request.onsuccess = () => resolve(request.result as T);
                request.onerror = () => this.errorHandler(request.error, "get", reject);
            });
        }

        public getAllAsync<T>(storeName: string): Promise<T[]> {
            return new Promise((resolve, reject) => {
                const store = this.getObjectStore(storeName);
                const cursor = store.openCursor();
                const data: T[] = [];

                cursor.onsuccess = () => {
                    if (cursor.result) {
                        data.push(cursor.result.value);
                        cursor.result.continue();
                    } else {
                        resolve(data);
                    }
                };
                cursor.onerror = () => this.errorHandler(cursor.error, "getAll", reject);
            });
        }

        public setAsync(storeName: string, data: any): Promise<void> {
            return new Promise((resolve, reject) => {
                const store = this.getObjectStore(storeName, "readwrite");
                let request: IDBRequest;

                if (typeof data.id !== "undefined" && data.id !== null) {
                    request = store.put(data);
                } else {
                    request = store.add(data);
                }

                request.onsuccess = () => resolve();
                request.onerror = () => this.errorHandler(request.error, "set", reject);
            });
        }

        public deleteAsync(storeName: string, id: string): Promise<void> {
            return new Promise((resolve, reject) => {
                const store = this.getObjectStore(storeName, "readwrite");
                const request = store.delete(id);
                request.onsuccess = () => resolve();
                request.onerror = () => this.errorHandler(request.error, "delete", reject);
            });
        }

        public deleteAllAsync(storeName: string): Promise<void> {
            return new Promise((resolve, reject) => {
                const store = this.getObjectStore(storeName, "readwrite");
                const request = store.clear();
                request.onsuccess = () => resolve();
                request.onerror = () => this.errorHandler(request.error, "deleteAll", reject);
            });
        }
    }

    class IndexedDbTranslationDb implements ITranslationDb {
        static TABLE = "files";
        static KEYPATH = "id";

        static dbName() {
            return `__pxt_translations_${pxt.appTarget.id || ""}`;
        }

        static createAsync(): Promise<IndexedDbTranslationDb> {
            function openAsync() {
                const idbWrapper = new IDBWrapper(IndexedDbTranslationDb.dbName(), 2, (ev, r) => {
                    const db = r.result as IDBDatabase;
                    db.createObjectStore(IndexedDbTranslationDb.TABLE, { keyPath: IndexedDbTranslationDb.KEYPATH });
                }, () => {
                    // quota exceeeded, delete db
                    clearTranslationDbAsync().catch(e => { });
                });
                return idbWrapper.openAsync()
                    .then(() => new IndexedDbTranslationDb(idbWrapper));
            }
            return openAsync()
                .catch(e => {
                    console.log(`db: failed to open database, try delete entire store...`)
                    return IDBWrapper.deleteDatabaseAsync(IndexedDbTranslationDb.dbName())
                        .then(() => openAsync());
                })
        }

        private db: IDBWrapper;
        private mem: MemTranslationDb;
        constructor(db: IDBWrapper) {
            this.db = db;
            this.mem = new MemTranslationDb();
        }
        getAsync(lang: string, filename: string, branch: string): Promise<ITranslationDbEntry> {
            lang = (lang || "en-US").toLowerCase(); // normalize locale
            const id = this.mem.key(lang, filename, branch);
            const r = this.mem.get(lang, filename, branch);
            if (r) return Promise.resolve(r);

            return this.db.getAsync<ITranslationDbEntry>(IndexedDbTranslationDb.TABLE, id)
                .then((res) => {
                    if (res) {
                        // store in-memory so that we don't try to download again
                        this.mem.set(lang, filename, branch, res.etag, res.time, res.strings);
                        return Promise.resolve(res);
                    }
                    return Promise.resolve(undefined);
                })
                .catch((e) => {
                    return Promise.resolve(undefined);
                });
        }
        setAsync(lang: string, filename: string, branch: string, etag: string, strings?: pxt.Map<string>, md?: string): Promise<void> {
            lang = (lang || "en-US").toLowerCase(); // normalize locale
            const id = this.mem.key(lang, filename, branch);
            let time = Util.now();
            this.mem.set(lang, filename, branch, etag, time, strings, md);

            if (strings) {
                Object.keys(strings).filter(k => !strings[k]).forEach(k => delete strings[k]);
            }

            const entry: ITranslationDbEntry = {
                id,
                etag,
                time,
                strings,
                md
            }
            return this.db.setAsync(IndexedDbTranslationDb.TABLE, entry)
                .finally(() => scheduleStorageCleanup()) // schedule a cleanpu
                .catch((e) => {
                    console.log(`db: set failed (${e.message}), recycling...`)
                    return this.clearAsync();
                });
        }

        clearAsync(): Promise<void> {
            return this.db.deleteAllAsync(IndexedDbTranslationDb.TABLE)
                .then(() => console.debug(`db: all clean`))
                .catch(e => {
                    console.error('db: failed to delete all');
                })
        }
    }

    // wired up in the app to store translations in pouchdb. MAY BE UNDEFINED!
    let _translationDbPromise: Promise<ITranslationDb>;
    export function translationDbAsync(): Promise<ITranslationDb> {
        if (pxt.Util.isNodeJS)
            return Promise.resolve(new MemTranslationDb());
        // try indexed db
        if (!_translationDbPromise)
            _translationDbPromise = IndexedDbTranslationDb.createAsync()
                .catch(() => new MemTranslationDb());
        return _translationDbPromise;
    }

    export function clearTranslationDbAsync(): Promise<void> {
        function deleteDbAsync() {
            const n = IndexedDbTranslationDb.dbName();
            return IDBWrapper.deleteDatabaseAsync(n)
                .then(() => {
                    _translationDbPromise = undefined;
                })
                .catch(e => {
                    pxt.log(`db: failed to delete ${n}`);
                    _translationDbPromise = undefined;
                });
        }

        if (!_translationDbPromise)
            return deleteDbAsync();
        return _translationDbPromise
            .then(db => db.clearAsync())
            .catch(e => deleteDbAsync().done());
    }

    export interface IPointerEvents {
        up: string,
        down: string[],
        move: string,
        enter: string,
        leave: string
    }

    export const pointerEvents: IPointerEvents = (() => {
        if (hasPointerEvents()) {
            return {
                up: "pointerup",
                down: ["pointerdown"],
                move: "pointermove",
                enter: "pointerenter",
                leave: "pointerleave"
            }
        } else if (isTouchEnabled()) {
            return {
                up: "mouseup",
                down: ["mousedown", "touchstart"],
                move: "touchmove",
                enter: "touchenter",
                leave: "touchend"
            }
        } else {
            return {
                up: "mouseup",
                down: ["mousedown"],
                move: "mousemove",
                enter: "mouseenter",
                leave: "mouseleave"
            }
        }
    })();

    export function getPageX(event: any) {
        if ("pageX" in event) {
            return (event as MouseEvent).pageX;
        }
        else {
            return (event as TouchEvent).changedTouches[0].pageX;
        }
    }

    export function getPageY(event: any) {
        if ("pageY" in event) {
            return (event as MouseEvent).pageY;
        }
        else {
            return (event as TouchEvent).changedTouches[0].pageY;
        }
    }

    export function getClientX(event: any) {
        if ("clientX" in event) {
            return (event as MouseEvent).clientX;
        }
        else {
            return (event as TouchEvent).changedTouches[0].clientX;
        }
    }

    export function getClientY(event: any) {
        if ("clientY" in event) {
            return (event as MouseEvent).clientY;
        }
        else {
            return (event as TouchEvent).changedTouches[0].clientY;
        }
    }

    export function popupWindow(url: string, title: string, popUpWidth: number, popUpHeight: number) {
        try {
            const winLeft = window.screenLeft ? window.screenLeft : window.screenX;
            const winTop = window.screenTop ? window.screenTop : window.screenY;
            const width = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
            const height = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
            const left = ((width / 2) - (popUpWidth / 2)) + winLeft;
            const top = ((height / 2) - (popUpHeight / 2)) + winTop;

            const popupWindow = window.open(url, title, "width=" + popUpWidth + ", height=" + popUpHeight + ", top=" + top + ", left=" + left);
            if (popupWindow.focus) {
                popupWindow.focus();
            }

            return popupWindow;
        } catch (e) {
            // Error opening popup
            pxt.tickEvent('pxt.popupError', { url: url, msg: e.message });
            return null;
        }
    }

    // Keep these helpers unified with pxtsim/runtime.ts
    export function containsClass(el: SVGElement | HTMLElement, classes: string) {
        return splitClasses(classes).every(cls => containsSingleClass(el, cls));

        function containsSingleClass(el: SVGElement | HTMLElement, cls: string) {
            if (el.classList) {
                return el.classList.contains(cls);
            } else {
                const classes = (el.className + "").split(/\s+/);
                return !(classes.indexOf(cls) < 0);
            }
        }
    }

    export function addClass(el: SVGElement | HTMLElement, classes: string) {
        splitClasses(classes).forEach(cls => addSingleClass(el, cls));

        function addSingleClass(el: SVGElement | HTMLElement, cls: string) {
            if (el.classList) {
                el.classList.add(cls);
            } else {
                const classes = (el.className + "").split(/\s+/);
                if (classes.indexOf(cls) < 0) {
                    el.className.baseVal += " " + cls;
                }
            }
        }
    }

    export function removeClass(el: SVGElement | HTMLElement, classes: string) {
        splitClasses(classes).forEach(cls => removeSingleClass(el, cls));

        function removeSingleClass(el: SVGElement | HTMLElement, cls: string) {
            if (el.classList) {
                el.classList.remove(cls);
            } else {
                el.className.baseVal = (el.className + "")
                    .split(/\s+/)
                    .filter(c => c != cls)
                    .join(" ");
            }
        }
    }

    function splitClasses(classes: string) {
        return classes.split(/\s+/).filter(s => !!s);
    }

    export function getCookieLang() {
        const cookiePropRegex = new RegExp(`${pxt.Util.escapeForRegex(pxt.Util.pxtLangCookieId)}=(.*?)(?:;|$)`)
        const cookieValue = cookiePropRegex.exec(document.cookie);
        return cookieValue && cookieValue[1] || null;
    }

    export function setCookieLang(langId: string, docs = false) {
        if (!pxt.Util.allLanguages[langId]) {
            return;
        }

        if (langId !== getCookieLang()) {
            pxt.tickEvent(`menu.lang.setcookielang`, { lang: langId, docs: `${docs}` });
            const expiration = new Date();
            expiration.setTime(expiration.getTime() + (pxt.Util.langCookieExpirationDays * 24 * 60 * 60 * 1000));
            document.cookie = `${pxt.Util.pxtLangCookieId}=${langId}; expires=${expiration.toUTCString()}; path=/`;
        }
    }
}
