# Number

An number value.

### @parent blocks/language

A *Number* is a numeric value that is an integer or a rational number. Numbers are stored in multiple bytes in _floating point_ format. This is so that numbers with a fractional portion can have precise calculations perfomed on them.

Some examples of different types of number values:

* 67 - positive integer
* -345 - negative integer
* 0 - zero
* 19.43 - floating point
* -45.245 - negative floating point
* 0.4567 - fractional floating point
* 8.23e+21 - floating point with exponent notation

### Declare a number variable

You can assign a number to a variable:

#### #declareexample

```block
let num = 42
```

### Arithmetic operators

The following arithmetic operators work on numbers and return a [Number](/types/number):

* addition: `1 + 3`
* subtraction: `1 - 3 `
* multiplication: `3 * 2`
* integer division: `7 / 3`
* modulo is available through the [math library](/blocks/math)

### Relational operators

The following relational operators work on numbers and return a [Boolean](/blocks/logic/boolean):

* equality: `(3 + 1) = 4`
* inequality: `3 != 4`
* less or equal than: `3 <= 4`
* less than: `3 < 4`
* greater or equal than : `4 >= 3`
* greater than: `4 > 3`

## #print

### Functions that return a number

Some functions return a number, which you can store in a variable. 

### #functionreturnexample

```block
let abs = Math.abs(-42)
```

### Math functions

The [math library](/blocks/math) includes math related functions. For example, the `min` function returns the minimum value of two input parameters `x` and `y`:

```block
let lowest = Math.min(-42, 1000)
```

### See also

[math](/blocks/math), [var](/blocks/variables/var), [Boolean](/blocks/logic/boolean)
