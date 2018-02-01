/// <reference path="../../built/pxtlib.d.ts"/>
/// <reference path="../../built/pxtcompiler.d.ts"/>


declare const importScripts: (...args: string[]) => void;

importScripts(
    "/blb/typescript.js",
    "/blb/fuse.min.js",
    "/blb/pxtlib.js",
    "/blb/pxtcompiler.js"
)

let pm: any = postMessage;

// work around safari not providing atob
if (typeof atob === "undefined") {
    //http://www.rise4fun.com/Bek/Cbl
    ts.pxtc.decodeBase64 = function (_input: string): string {
        function _D(_x: number): number { return ((_x == 0x2F) ? 0x3F : ((_x == 0x2B) ? 0x3E : ((_x <= 0x39) ? (_x + 0x4) : ((_x <= 0x5A) ? (_x - 0x41) : (_x - 0x47))))); };

        function _Bits(m: number, n: number, c: number): number {
            let mask = 0;
            for (let i = 0; i <= (m - n); i++) { mask = (mask << 1) + 1; }
            return (c >> n) & mask;
        };
        let result = new Array();
        let _q0 = true;
        let _q1 = false;
        let _q2 = false;
        let _q3 = false;
        let _q4 = false;
        let _q5 = false;
        let _r = 0x0;
        let rx = new RegExp("^([A-Za-z0-9+/=])$");
        for (let _i = 0; _i < _input.length; _i++) {
            let _x = _input.charCodeAt(_i);
            if ((!String.fromCharCode(_x).match(rx) || ((_x == 0x3D) && (_q0 || _q1)) || ((_x == 0x3D) && !(_r == 0x0)) || (!(_x == 0x3D) && _q4) || _q5)) {
                // throw { name: 'InvalidInput' };
                return undefined;
            }
            else if (_q0) {
                _r = (_D(_x) << 0x2);
                _q0 = false;
                _q1 = true;
                _q2 = false;
                _q3 = false;
                _q4 = false;
                _q5 = false;
            }
            else if (_q1) {
                result.push(String.fromCharCode((_r | _Bits(0x5, 0x4, _D(_x)))));
                _r = ((_D(_x) & 0xF) << 0x4);
                _q0 = false;
                _q1 = false;
                _q2 = true;
                _q3 = false;
                _q4 = false;
                _q5 = false;
            }
            else if (_q2) {
                if ((_x == 0x3D)) {
                    _r = 0x0;
                    _q0 = false;
                    _q1 = false;
                    _q2 = false;
                    _q3 = false;
                    _q4 = true;
                    _q5 = false;
                }
                else {
                    result.push(String.fromCharCode((_r | _Bits(0x5, 0x2, _D(_x)))));
                    _r = ((_D(_x) & 0x3) << 0x6);
                    _q0 = false;
                    _q1 = false;
                    _q2 = false;
                    _q3 = true;
                    _q4 = false;
                    _q5 = false;
                }
            }
            else if (_q3) {
                if ((_x == 0x3D)) {
                    _r = 0x0;
                    _q0 = false;
                    _q1 = false;
                    _q2 = false;
                    _q3 = false;
                    _q4 = false;
                    _q5 = true;
                }
                else {
                    result.push(String.fromCharCode((_r | _D(_x))));
                    _r = 0x0;
                    _q0 = true;
                    _q1 = false;
                    _q2 = false;
                    _q3 = false;
                    _q4 = false;
                    _q5 = false;
                }
            }
            else if (_q4) {
                _r = 0x0;
                _q0 = false;
                _q1 = false;
                _q2 = false;
                _q3 = false;
                _q4 = false;
                _q5 = true;
            }
        }
        if (!(_q0 || _q5)) {
            //throw { name: 'InvalidInput' };
            return undefined;
        }
        const r = result.join('');
        return r;
    }
}

// Polyfill for Uint8Array.slice for IE and Safari
// https://tc39.github.io/ecma262/#sec-%typedarray%.prototype.slice
if (!Uint8Array.prototype.slice) {
    Object.defineProperty(Uint8Array.prototype, 'slice', {
        value: Array.prototype.slice,
        writable: true,
        enumerable: true
    });
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/fill
if (!Uint8Array.prototype.fill) {
    Object.defineProperty(Uint8Array.prototype, 'fill', {
        writable: true,
        enumerable: true,
        value: function (value: Uint8Array) {

            // Steps 1-2.
            if (this == null) {
                throw new TypeError('this is null or not defined');
            }

            let O = Object(this);

            // Steps 3-5.
            let len = O.length >>> 0;

            // Steps 6-7.
            let start = arguments[1];
            let relativeStart = start >> 0;

            // Step 8.
            let k = relativeStart < 0 ?
                Math.max(len + relativeStart, 0) :
                Math.min(relativeStart, len);

            // Steps 9-10.
            let end = arguments[2];
            let relativeEnd = end === undefined ?
                len : end >> 0;

            // Step 11.
            let final = relativeEnd < 0 ?
                Math.max(len + relativeEnd, 0) :
                Math.min(relativeEnd, len);

            // Step 12.
            while (k < final) {
                O[k] = value;
                k++;
            }

            // Step 13.
            return O;
        }
    });
}

onmessage = ev => {
    let res = pxtc.service.performOperation(ev.data.op, ev.data.arg)
    pm({
        op: ev.data.op,
        id: ev.data.id,
        result: JSON.parse(JSON.stringify(res))
    })
}

pm({
    id: "ready"
})
