type Action = () => void;

/**
 * Constant representing Not-A-Number.
 */
const NaN = 0 / 0

/**
 * Constant representing positive infinity.
 */
const Infinity = 1 / 0

function isNaN(x: number) {
    x = +x // convert to number
    return x !== x
}

namespace Number {
    /**
     * Check if a given value is of type Number and it is a NaN.
     */
    export function isNaN(x: any): boolean {
        return typeof x == "number" && x !== x
    }
}

/**
 * A dictionary from string key to string values
 */
interface StringMap {
    [index: string]: string;
}

/**
  * Convert a string to an integer.
  * @param text A string to convert into an integral number. eg: "123"
  * @param radix optional A value between 2 and 36 that specifies the base of the number in text.
  * If this argument is not supplied, strings with a prefix of '0x' are considered hexadecimal.
  * All other strings are considered decimal.
  */
//% help=text/parse-int
//% blockId="string_parseint" block="parse to integer %text" blockNamespace="text"
//% text.defl="123"
//% blockHidden=1
function parseInt(text: string, radix?: number): number {
    // roughly based on https://www.ecma-international.org/ecma-262/5.1/#sec-15.1.2.2
    // with some consideration for avoiding unnecessary slices where easy
    if (!text || (radix != null && (radix < 2 || radix > 36)))
        return NaN;

    let start = 0;
    while (start < text.length && helpers.isWhitespace(text.charCodeAt(start)))
        ++start;

    if (start === text.length)
        return NaN;

    const numberOffset = 48; // 0
    const numCount = 10;
    const letterOffset = 97; // a
    const letterCount = 26;
    const lowerCaseMask = 0x20;

    let sign = 1;
    switch (text.charAt(start)) {
        case "-":
            sign = -1;
            // fallthrough
        case "+":
            ++start;
    }

    if ((!radix || radix == 16)
            && "0" === text[start]
            && ("x" === text[start + 1] || "X" === text[start + 1])) {
        radix = 16;
        start += 2;
    } else if (!radix) {
        radix = 10;
    }

    let output = 0;
    let hasDigit = false;
    for (let i = start; i < text.length; ++i) {
        const code = text.charCodeAt(i) | lowerCaseMask;
        let val: number = undefined;

        if (code >= numberOffset && code < numberOffset + numCount)
            val = code - numberOffset;
        else if (code >= letterOffset && code < letterOffset + letterCount)
            val = numCount + code - letterOffset;

        if (val == undefined || val >= radix) {
            if (!hasDigit) {
                return NaN;
            }
            break;
        }
        hasDigit = true;
        output = output * radix + val;
    }

    return sign * output;
}

namespace helpers {
    export function arrayFill<T>(O: T[], value: T, start?: number, end?: number) {
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/fill
        // Steps 3-5.
        const len = O.length >>> 0;

        // Steps 6-7.
        const relativeStart = start === undefined ? 0 : start >> 0;

        // Step 8.
        let k = relativeStart < 0 ?
            Math.max(len + relativeStart, 0) :
            Math.min(relativeStart, len);

        // Steps 9-10.
        const relativeEnd = end === undefined ? len : end >> 0;

        // Step 11.
        const final = relativeEnd < 0 ?
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

    export function arraySplice<T>(arr: T[], start: number, len: number) {
        if (start < 0) {
            return;
        }
        for (let i = 0; i < len; ++i) {
            arr.removeAt(start)
        }
    }

    export function arrayReverse<T>(arr: T[]): void {
        let len = arr.length;
        for (let i = 0; i < len / 2; i++) {
            swap(arr, i, len - i - 1);
        }
    }

    export function arrayShift<T>(arr: T[]): T {
        return arr.removeAt(0);
    }

    export function arrayJoin<T>(arr: T[], sep?: string): string {
        if (sep === undefined || sep === null) {
            sep = ",";
        }

        let r = "";
        let len = arr.length // caching this seems to match V8
        for (let i = 0; i < len; ++i) {
            if (i > 0 && sep)
                r += sep;
            r += (arr[i] === undefined || arr[i] === null) ? "" : arr[i];
        }
        return r;
    }

    /*TODO: Enable this multiple value unshift, after rest is enabled in our compiler.
        export function arrayUnshift<T>(arr: T[], ...values: T[]) : number {
            for(let i = values.length; i > 0; --i) {
                arr.insertAt(0, values[i - 1]);
            }
            return arr.length;
        }
    */
    export function arrayUnshift<T>(arr: T[], value: T): number {
        arr.insertAt(0, value);
        return arr.length;
    }

    function swap<T>(arr: T[], i: number, j: number): void {
        let temp: T = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
    }

    function sortHelper<T>(arr: T[], callbackfn: (value1: T, value2: T) => number): T[] {
        if (arr.length > 1 && callbackfn) {
            if (arr.length < 50) {
                // simple selection sort for small arrays
                const len = arr.length;
                for (let i = 0; i < len - 1; ++i) {
                    for (let j = i + 1; j < len; ++j) {
                        if (callbackfn(arr[i], arr[j]) > 0) {
                            swap(arr, i, j);
                        }
                    }
                }
            } else {
                // heap sort for larger arrays
                arr =  heapSort(arr, callbackfn);
            }
        }

        return arr;
    }

    function heapSort<T>(arr: T[], callbackfn: (value1: T, value2: T) => number): T[] {
        function buildMaxHeap(a: T[]) {
            let i = Math.floor(a.length / 2 - 1);

            while (i >= 0) {
                heapify(a, i, a.length);
                i -= 1;
            }
        }

        function heapify(heap: T[], i: number, max: number) {
            while (i < max) {
                const left = 2 * i + 1;
                const right = left + 1;
                let curr = i;

                if (left < max && callbackfn(heap[curr], heap[left]) < 0) {
                    curr = left;
                }

                if (right < max && callbackfn(heap[curr], heap[right]) < 0) {
                    curr = right;
                }

                if (curr == i) return;

                swap(heap, i, curr);
                i = curr;
            }
        }

        buildMaxHeap(arr);

        for (let i = arr.length - 1; i > 0; --i) {
            swap(arr, 0, i);
            heapify(arr, 0, i);
        }

        return arr;
    }

    export function arraySort<T>(arr: T[], callbackfn?: (value1: T, value2: T) => number): T[] {
        if (!callbackfn && arr.length > 1) {
            callbackfn = (a, b) => {
                // default is sort as if the element were a string, with null < undefined
                const aIsUndef = a === undefined;
                const bIsUndef = b === undefined;
                if (aIsUndef && bIsUndef) return 0;
                else if (aIsUndef) return 1;
                else if (bIsUndef) return -1;

                const aIsNull = a === null;
                const bIsNull = b === null;
                if (aIsNull && bIsNull) return 0;
                else if (aIsNull) return 1;
                else if (bIsNull) return -1;

                return (a + "").compare(b + "");
            }
        }
        return sortHelper(arr, callbackfn);
    }

    export function arrayMap<T, U>(arr: T[], callbackfn: (value: T, index: number) => U): U[] {
        let res: U[] = []
        let len = arr.length // caching this seems to match V8
        for (let i = 0; i < len; ++i) {
            res.push(callbackfn(arr[i], i))
        }
        return res
    }

    export function arraySome<T>(arr: T[], callbackfn: (value: T, index: number) => boolean): boolean {
        let len = arr.length // caching this seems to match V8
        for (let i = 0; i < len; ++i)
            if (callbackfn(arr[i], i))
                return true;
        return false;
    }

    export function arrayEvery<T>(arr: T[], callbackfn: (value: T, index: number) => boolean): boolean {
        let len = arr.length // caching this seems to match V8
        for (let i = 0; i < len; ++i)
            if (!callbackfn(arr[i], i))
                return false;
        return true;
    }

    export function arrayForEach<T>(arr: T[], callbackfn: (value: T, index: number) => void): void {
        let len = arr.length // caching this seems to match V8
        for (let i = 0; i < len; ++i) {
            callbackfn(arr[i], i);
        }
    }

    export function arrayFilter<T>(arr: T[], callbackfn: (value: T, index: number) => boolean): T[] {
        let res: T[] = []
        let len = arr.length
        for (let i = 0; i < len; ++i) {
            let v = arr[i] // need to cache
            if (callbackfn(v, i)) res.push(v)
        }
        return res
    }

    export function arrayFind<T>(arr: T[], callbackfn: (value: T, index: number) => boolean): T {
        let len = arr.length
        for (let i = 0; i < len; ++i) {
            let v = arr[i] // need to cache
            if (callbackfn(v, i)) return v;
        }
        return undefined;
    }

    export function arrayReduce<T, U>(arr: T[], callbackfn: (previousValue: U, currentValue: T, currentIndex: number) => U, initialValue: U): U {
        let len = arr.length
        for (let i = 0; i < len; ++i) {
            initialValue = callbackfn(initialValue, arr[i], i)
        }
        return initialValue
    }

    export function arrayConcat<T>(arr: T[], otherArr: T[]): T[] {
        let out: T[] = [];
        for (let value of arr) {
            out.push(value);
        }
        for (let value of otherArr) {
            out.push(value);
        }
        return out;
    }

    export function arraySlice<T>(arr: T[], start?: number, end?: number): T[] {
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/slice
        const res: T[] = [];
        const len = arr.length;

        if (start === undefined)
            start = 0;
        else if (start < 0)
            start = Math.max(len + start, 0);

        if (start > len)
            return res;

        if (end === undefined)
            end = len;
        else if (end < 0)
            end = len + end;

        if (end > len)
            end = len;

        for (let i = start; i < end; ++i) {
            res.push(arr[i]);
        }
        return res;
    }

    export function stringReplace(s: string, toReplace: string, replacer: string | ((sub: string) => string)) {
        toReplace = toReplace + "";
        const ind = s.indexOf(toReplace);
        if (ind == -1)
            return s;

        const begin = s.slice(0, ind);
        const end = s.slice(ind + toReplace.length);

        if (typeof replacer == "string" || !replacer) {
            return begin + replacer + end;
        } else {
            return begin + replacer(toReplace) + end;
        }
    }

    export function stringReplaceAll(s: string, toReplace: string, replacer: string | ((sub: string) => string)) {
        toReplace = toReplace + "";
        const split = s.split(toReplace);
        const empty = toReplace.isEmpty();

        let output = (empty ? applyReplace(toReplace, replacer) : "");

        if (split.length) {
            output += split[0];
        }

        for (let i = 1; i < split.length; ++i) {
            output += applyReplace(toReplace, replacer) + split[i];
        }

        if (!s.isEmpty() && empty) {
            output += applyReplace(toReplace, replacer);
        }

        return output;

        function applyReplace(r: string, replacer: string | ((sub: string) => string)): string {
            if (typeof replacer == "string" || !replacer) {
                return replacer as string;
            } else {
                return replacer(r);
            }
        }
    }


    export function stringSlice(s: string, start: number, end?: number): string {
        const len = s.length;

        if (start < 0) {
            start = Math.max(len + start, 0);
        }

        if (end == null) {
            end = len;
        }

        if (end < 0) {
            end = len + end;
        }

        return s.substr(start, end - start);
    }

    // TODO move to PXT
    // also note this doesn't handle unicode, but neither does JS (there's toLocaleLowerCase())
    export function stringToLowerCase(s: string): string {
        let r = ""
        let prev = 0
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i)
            if (65 <= c && c <= 90) {
                r += s.slice(prev, i) + String.fromCharCode(c + 32)
                prev = i + 1
            }
        }
        r += s.slice(prev)
        return r
    }

    export function stringSplit(S: string, separator?: string, limit?: number): string[] {
        // https://www.ecma-international.org/ecma-262/6.0/#sec-string.prototype.split
        const A: string[] = [];
        let lim = 0;
        if (limit === undefined)
            lim = (1 << 29) - 1; // spec says 1 << 53, leaving it at 29 for constant folding
        else if (limit < 0)
            lim = 0;
        else
            lim = limit | 0;
        const s = S.length;
        let p = 0;
        const R = separator;
        if (lim == 0)
            return A;
        if (separator === undefined) {
            A[0] = S;
            return A;
        }
        if (s == 0) {
            let z = splitMatch(S, 0, R);
            if (z > -1) return A;
            A[0] = S;
            return A;
        }
        let T: string;
        let q = p;
        while (q != s) {
            let e = splitMatch(S, q, R);
            if (e < 0) q++;
            else {
                if (e == p) q++;
                else {
                    T = stringSlice(S, p, q);
                    A.push(T);
                    if (A.length == lim) return A;
                    p = e;
                    q = p;
                }
            }
        }
        T = stringSlice(S, p, q);
        A.push(T);
        return A;
    }

    function splitMatch(S: string, q: number, R: string): number {
        const r = R.length;
        const s = S.length;
        if (q + r > s) return -1;
        for (let i = 0; i < r; ++i) {
            if (S[q + i] != R[i])
                return -1;
        }
        return q + r;
    }

    export function stringTrim(s: string): string {
        let start = 0;
        let end = s.length - 1;

        while (start <= end && isWhitespace(s.charCodeAt(start)))
            ++start;

        while (end > start && isWhitespace(s.charCodeAt(end)))
            --end;
        return s.slice(start, end + 1);
    }

    export function isWhitespace(c: number): boolean {
        // https://www.ecma-international.org/ecma-262/6.0/#sec-white-space
        switch (c) {
            case 0x0009:  // character tab
            case 0x000B:  // line tab
            case 0x000C:  // form feed
            case 0x0020:  // space
            case 0x00A0:  // no-break space
            case 0xFEFF:  // zero width no break space
            case 0x000A:  // line feed
            case 0x000D:  // carriage return
            case 0x2028:  // line separator
            case 0x2029:  // paragraph separator
                return true;
            default:
                return false;
        }
    }

    export function stringEmpty(S: string): boolean {
        return !S;
    }
}

namespace Math {
    export function clamp(min: number, max: number, value: number): number {
        return Math.min(max, Math.max(min, value));
    }

    /**
      * Returns the absolute value of a number (the value without regard to whether it is positive or negative).
      * For example, the absolute value of -5 is the same as the absolute value of 5.
      * @param x A numeric expression for which the absolute value is needed.
      */
    //% help=math/abs
    export function abs(x: number): number {
        return x < 0 ? -x : x;
    }

    /**
      * Returns the sign of the x, indicating whether x is positive, negative or zero.
      * @param x The numeric expression to test
      */
    export function sign(x: number): number {
        if (x == 0) return 0;
        if (x > 0) return 1;
        return -1;
    }

    /**
      * Returns the larger of two supplied numeric expressions.
      */
    //% help=math/max
    export function max(a: number, b: number): number {
        if (a >= b) return a;
        return b;
    }

    /**
      * Returns the smaller of two supplied numeric expressions.
      */
    //% help=math/min
    export function min(a: number, b: number): number {
        if (a <= b) return a;
        return b;
    }

    /**
     * Rounds ``x`` to a number with the given number of ``digits``
     * @param x the number to round
     * @param digits the number of resulting digits
     */
    //%
    export function roundWithPrecision(x: number, digits: number): number {
        digits = digits | 0;
        // invalid digits input
        if (digits <= 0) return Math.round(x);
        if (x == 0) return 0;
        let r = 0;
        do {
            const d = Math.pow(10, digits);
            r = Math.round(x * d) / d;
            digits++;
        } while (r == 0 && digits < 21);
        return r;
    }
}


//% blockHidden=1
namespace __internal {
    /**
     * A shim to render a boolean as a down/up toggle
     */
    //% shim=TD_ID blockHidden=1
    //% blockId=toggleDownUp block="%down"
    //% down.fieldEditor=toggledownup
    //% down.fieldOptions.decompileLiterals=true
    export function __downUp(down: boolean): boolean {
        return down;
    }

    /**
     * A shim to render a boolean as a up/down toggle
     */
    //% shim=TD_ID blockHidden=1
    //% blockId=toggleUpDown block="%up"
    //% up.fieldEditor=toggleupdown
    //% up.fieldOptions.decompileLiterals=true
    export function __upDown(up: boolean): boolean {
        return up;
    }

    /**
     * A shim to render a boolean as a high/low toggle
     */
    //% shim=TD_ID blockHidden=1
    //% blockId=toggleHighLow block="%high"
    //% high.fieldEditor=togglehighlow
    //% high.fieldOptions.decompileLiterals=true
    export function __highLow(high: boolean): boolean {
        return high;
    }

    /**
     * A shim to render a boolean as a on/off toggle
     */
    //% shim=TD_ID blockHidden=1
    //% blockId=toggleOnOff block="%on"
    //% on.fieldEditor=toggleonoff
    //% on.fieldOptions.decompileLiterals=true
    export function __onOff(on: boolean): boolean {
        return on;
    }

    /**
     * A shim to render a boolean as a yes/no toggle
     */
    //% shim=TD_ID blockHidden=1
    //% blockId=toggleYesNo block="%yes"
    //% yes.fieldEditor=toggleyesno
    //% yes.fieldOptions.decompileLiterals=true
    export function __yesNo(yes: boolean): boolean {
        return yes;
    }

    /**
     * A shim to render a boolean as a win/lose toggle
     */
    //% shim=TD_ID blockHidden=1
    //% blockId=toggleWinLose block="%win"
    //% win.fieldEditor=togglewinlose
    //% win.fieldOptions.decompileLiterals=true
    export function __winLose(win: boolean): boolean {
        return win;
    }

    /**
     * Get the color wheel field editor
     * @param color color, eg: #ff0000
     */
    //% blockId=colorNumberPicker block="%value"
    //% blockHidden=true
    //% shim=TD_ID colorSecondary="#FFFFFF"
    //% value.fieldEditor="colornumber" value.fieldOptions.decompileLiterals=true
    //% value.defl='#ff0000'
    //% value.fieldOptions.colours='["#ff0000","#ff8000","#ffff00","#ff9da5","#00ff00","#b09eff","#00ffff","#007fff","#65471f","#0000ff","#7f00ff","#ff0080","#ff00ff","#ffffff","#999999","#000000"]'
    //% value.fieldOptions.columns=4 value.fieldOptions.className='rgbColorPicker'
    export function __colorNumberPicker(value: number) {
        return value;
    }

    /**
     * Get the color wheel field editor
     * @param value value between 0 to 255 to get a color value, eg: 10
     */
    //% blockId=colorWheelPicker block="%value"
    //% blockHidden=true
    //% shim=TD_ID colorSecondary="#FFFFFF"
    //% value.fieldEditor="colorwheel" value.fieldOptions.decompileLiterals=true
    //% value.fieldOptions.sliderWidth='200'
    //% value.fieldOptions.min=0 value.fieldOptions.max=255
    export function __colorWheelPicker(value: number) {
        return value;
    }

    /**
    * Get the color wheel field editor using HSV values
    * @param value value between 0 to 255 to get a color value, eg: 10
    */
    //% blockId=colorWheelHsvPicker block="%value"
    //% blockHidden=true
    //% shim=TD_ID colorSecondary="#FFFFFF"
    //% value.fieldEditor="colorwheel" value.fieldOptions.decompileLiterals=true
    //% value.fieldOptions.sliderWidth='200'
    //% value.fieldOptions.min=0 value.fieldOptions.max=255
    //% value.fieldOptions.channel=hsvfast
    export function __colorWheelHsvPicker(value: number) {
        return value;
    }

    /**
     * A speed picker
     * @param speed the speed, eg: 50
     */
    //% blockId=speedPicker block="%speed" shim=TD_ID
    //% speed.fieldEditor="speed" colorSecondary="#FFFFFF"
    //% weight=0 blockHidden=1 speed.fieldOptions.decompileLiterals=1
    export function __speedPicker(speed: number): number {
        return speed;
    }

    /**
     * A turn ratio picker
     * @param turnratio the turn ratio, eg: 0
     */
    //% blockId=turnRatioPicker block="%turnratio" shim=TD_ID
    //% turnratio.fieldEditor="turnratio" colorSecondary="#FFFFFF"
    //% weight=0 blockHidden=1 turnRatio.fieldOptions.decompileLiterals=1
    export function __turnRatioPicker(turnratio: number): number {
        return turnratio;
    }

    /**
     * A field editor that displays a protractor
     */
    //% blockId=protractorPicker block="%angle"
    //% shim=TD_ID
    //% angle.fieldEditor=protractor
    //% angle.fieldOptions.decompileLiterals=1
    //% colorSecondary="#FFFFFF"
    //% blockHidden=1
    export function __protractor(angle: number) {
        return angle;
    }

    /**
      * Get the time field editor
      * @param ms time duration in milliseconds, eg: 500, 1000
      */
    //% blockId=timePicker block="%ms"
    //% blockHidden=true shim=TD_ID
    //% colorSecondary="#FFFFFF"
    //% ms.fieldEditor="numberdropdown" ms.fieldOptions.decompileLiterals=true
    //% ms.fieldOptions.data='[["100 ms", 100], ["200 ms", 200], ["500 ms", 500], ["1 second", 1000], ["2 seconds", 2000], ["5 seconds", 5000]]'
    export function __timePicker(ms: number): number {
        return ms;
    }
}