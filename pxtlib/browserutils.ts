
namespace pxt.BrowserUtils {
    export function isWindows(): boolean {
        return !!navigator && /Win32/i.test(navigator.platform);
    }

    //MacIntel on most modern Macs
    export function isMac(): boolean {
        return !!navigator && /Mac/i.test(navigator.platform);
    }

    //Edge lies about its user agent and claims to be Chrome, but Edge/Version
    //is always at the end
    export function isEdge(): boolean {
        return !!navigator && /Edge/i.test(navigator.userAgent);
    }

    //IE11 also lies about its user agent, but has Trident appear somewhere in
    //the user agent. Detecting the different between IE11 and Edge isn't
    //super-important because the UI is similar enough
    export function isIE(): boolean {
        return !!navigator && /Trident/i.test(navigator.userAgent);
    }

    //Edge and IE11 lie about being Chrome
    export function isChrome(): boolean {
        return !isEdge() && !isIE() && !!navigator && /Chrome/i.test(navigator.userAgent);
    }

    //Chrome lies about being Safari
    export function isSafari(): boolean {
        //Could also check isMac but I don't want to risk excluding iOS
        return !isChrome() && !!navigator && /Safari/i.test(navigator.userAgent);
    }

    //Safari and WebKit lie about being Firefox
    export function isFirefox(): boolean {
        return !isSafari && !navigator && /Firefox/i.test(navigator.userAgent);
    }

    export function browserDownloadText(text: string, name: string, contentType: string = "application/octet-stream", onError?: (err: any) => void): string {
        pxt.debug('trigger download')
        let buf = Util.stringToUint8Array(Util.toUTF8(text))
        return browserDownloadUInt8Array(buf, name, contentType, onError);
    }

    function browserDownloadUInt8Array(buf: Uint8Array, name: string, contentType: string = "application/octet-stream", onError?: (err: any) => void): string {
        const isMobileBrowser = /mobile/.test(navigator.userAgent);
        const isSafari = /safari/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent);
        const isDesktopIE = (<any>window).navigator.msSaveOrOpenBlob && !isMobileBrowser;

        const dataurl = "data:" + contentType + ";base64," + btoa(Util.uint8ArrayToString(buf))
        try {
            if (isDesktopIE) {
                let b = new Blob([buf], { type: contentType })
                let result = (<any>window).navigator.msSaveOrOpenBlob(b, name);
            } else if (isSafari) {
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
                iframe.src = dataurl;
            } else {
                let link = <any>window.document.createElement('a');
                if (typeof link.download == "string") {
                    link.href = dataurl;
                    link.download = name;
                    document.body.appendChild(link); // for FF
                    link.click();
                    document.body.removeChild(link);
                } else {
                    document.location.href = dataurl;
                }
            }
        } catch (e) {
            if (onError) onError(e);
            pxt.debug("saving failed")
        }
        return dataurl;
    }

}