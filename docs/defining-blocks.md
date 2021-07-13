# Defining blocks

This section describes how to annotate your MakeCode APIs to expose them in the Block Editor.

```block
let APIs = false;
let Annotations = false;
let Blocks = APIs && Annotations;
```

### ~ hint

#### Blocks Playground

Try out some blocks live in the **[Playground](https://makecode.com/playground)** to see how they work. Modify them or even create new ones!

### ~

Blocks are defined by annotations added to the beginning of an API element (export function, method, enum, etc.). Attributes are specified on annotation lines that begin with the comment form of `//%`. All of the `//%` annotations are found in TypeScript library files containg the code for the exposed APIs.
They can optionally be [auto-generated](/simshim) from C++ library files or from TypeScript
simulator files.

## Category

Each top-level TypeScript namespace is used to populate a category in the Block Editor toolbox. The name will automatically be capitalized in the toolbox.

```typescript-ignore
namespace basic {
    ...
}
```

You can also provide a JsDoc comment, color and weight for the namespace, as well as a friendly name (in Unicode).
We strongly recommend carefully picking colors as it dramatically impacts
that appearance and readability of your blocks. All blocks within the same namespace have the same color so that users can find the category easily from
samples.

```typescript-ignore
/**
 * Provides access to basic micro:bit functionality.
 */
//% color=190 weight=100 icon="\uf1ec" block="Basic Blocks"
namespace basic {
    ...
}
```

* `icon` icon Unicode character from the icon font to display. The [Semantic UI](https://semantic-ui.com/elements/icon.html) icon set has been ported from Font Awesome (v4.5.6 at the time of writing), and a full list can be found at http://fontawesome.io/icons/
* `color` should be included in a comment line starting with `//%`. The color takes a **hue** value or a HTML color.
* `weight` determines where your category appears in the toolbox. Higher weight means it appears closer to the top.

To have a category appear under the "Advanced" section of the Block Editor toolbox, add the annotation `advanced=true`.

### Category groups

You can make your block category more organized by grouping similar or related blocks together inside [**groups**](/playground#basic-groups). When using the groups feature, blocks of the same group will appear together in the toolbox flyout and the group's label will be displayed above them.
This makes it easier for the user to go through your available blocks.

To define your groups, add the `groups` attribute to your namespace. The `groups` attribute is an array of group names. You can individually assign blocks to these groups when defining each block.

### ~ hint

#### Group ordering

* The order in which you define your groups is the order in which the groups will appear in the toolbox flyout.
* Blocks that are not assigned to a named group are placed in the default `others` group, which does not show a label. The `others` group can be used to decide where in the order of groups the ungrouped blocks will appear. This is based on where you place `others` in the `groups` array.
* When assigning blocks to groups, names are case sensitive, so make sure the group names you put on your blocks are identical to the ones in your group definitions.

### ~

```typescript-ignore
/**
 * Provides access to basic micro:bit functionality.
 */
//% color=190 weight=100 icon="\uf1ec" block="Basic Blocks"
//% groups=['LED matrix', 'Control flow', 'others']
namespace basic {
    //% block="clear LEDs"
    //% group="LED matrix"
    export function clearLEDs() {

    }

    //% block="cancel timer"
    //% group="Control Flow"
    export function cancelTimer() {

    }
}
```

## Blocks

All **exported** functions with a `block` attribute will be available in the Block Editor.

```typescript-ignore
//% block
export function showNumber(v: number, interval: number = 150): void
{ }
```

If you need more control over the appearance of the block,
you can specify the `blockId` and `block` parameters.

```typescript-ignore
//% blockId=device_show_number
//% block="show|number %v"
export function showNumber(v: number, interval: number = 150): void
{ }
```

* `blockId` is a constant, unique id for the block. This id is serialized in block code so changing
  it will break your users. If not specified, it is derived from namespace and function names,
  so renaming your functions or namespaces will break both your TypeScript and Blocks users.
* `block` contains the syntax to build the block structure (more below).

Other optional attributes can also be used:
* `blockExternalInputs=` forces `External Inputs` rendering
* `advanced=true` causes this block to be placed under the parent category's "More..." subcategory. Useful for hiding advanced or rarely-used blocks by default

## Block syntax

The `block` attribute specifies how the parameters of the function
will be organized to create the block.

```
block = field, { '|' field }
field := string
    | string `%` parameter [ `=` type ]
parameter = string
type = string
```

* each `field` is mapped to a field in the block editor
* the function parameter are mapped **in order** to `%parameter` argument. The loader automatically builds
a mapping between the block field names and the function names.
* the block will automatically switch to external inputs when enough parameters are detected
* Using `=type` in the block string for shadow blocks is deprecated. See "Specifying shadow blocks" for more details.

## Custom block localization

You can override the value used in ``block`` for a particular locale by provide a ``block.loc.LOCALE`` entry.

```
block.loc.LOCALE = blocksyntax
```

For example,

```typescript-ignore
//% block="square $x"
//% block.loc.fr="$x au carré"
function square(x: number): number {}
```

You can also override the ``jsDoc`` description and parameter info.

```
jsdoc.loc.LOCALE = translated jsdoc
PARAM.loc.LOCALE = parameter jsdoc
```

```typescript-ignore
/**
    Computes the square of x
    @param x the number to square
**/
//% block="square $x"
//% block.loc.fr="$x au carré"
//% jsdoc.loc.fr="Calcule le carré de x"
//% x.loc.fr="le nombre"
function square(x: number): number {}
```


## Supported types

The following [types](/playground#basic-types) are supported in function signatures that are meant to be exported:

* ``number`` (TypeScript) or ``int`` (C++)
* ``string`` (TypeScript) or ``StringData*`` (C++)
* enums (see below)
* custom classes that are also exported
* arrays of the above

## Specifying shadow blocks #shadow-block

A "shadow" block is a block which cannot be removed from its parent but can have
other blocks placed on top. They are used to ensure that block inputs always have
valid values instead of leaving a "hole" behind when a block is removed. All parameters
are given shadow blocks in PXT for the supported types (listed above). To specify a shadow block
for an unsupported type or to override a default shadow, use the following syntax:

```typescript-ignore
//% block="$myParam"
//% myParam.shadow="myShadowBlockID"
function myFunction(myParam: number): void {}
```

If an existing block definition specifies the shadow block id within the block string,
the value can be changed using the above syntax without altering the block string. This
allows the shadow block to be changed without invalidating the localization of the block.
Setting the shadow id to `unset` will remove any existing shadow value.

## Specifying min, max, and default values

For parameters of type ``number``, you can specify a minimum, maximum, and default values, as follows:

```typescript-ignore
//% block
//% v.min=0 v.max= 42 x.defl=25
export function showNumber(v: number, interval: number = 150): void
{ }
```

>**Note**: Using ``defl`` to specify a default parameter value will take precedence over a default value given in the `eg:` portion for ``@param`` in JsDoc. See the [Docs and default values](#jsdoc) section below.

**Playground examples**: [Range](https://makecode.com/playground#field-editors-range), [Default values](https://makecode.com/playground#basic-default-values)


## Reporter blocks and Statement blocks

Reporter blocks are the round or hexagonal blocks that can be slotted into the inputs of other blocks.
Any function that has a return type other than void will be made into a reporter block if it has the `block` comment attribute.
Occasionally there are functions that return a value but are also useful as statements, for example `Array.pop()` returns
an element of the array but it is common in JavaScript to ignore that value.
To define a block that has both a reporter and a statement form, use the `blockAliasFor` comment attribute:

```typescript-ignore
/**
* Remove the last element from an array and return it.
*/
//% blockId="array_pop" block="get and remove last value from %list"
function pop(): number;

/**
* Remove the last element from an array and return it.
*/
//% blockId="array_pop_statement" block="remove last value from %list"
//% blockAliasFor="Array.pop"
function _popStatement(): void;

```

In the example above, both the blocks defined by `pop()` and `_popStatement()` will be converted to `Array.pop()`.
Note that `_popStatement()` begins with an underscore to prevent it from showing up in text completions in the monaco editor.
Any block defined as an alias should have the same arguments as the source function.
The value of `blockAliasFor` should be the fully qualified name of the source function.

## Array default values

For array type parameters, set the shadow ID to "lists_create_with":

```typescript-ignore
//% block="$myParam"
//% myParam.shadow="lists_create_with"
function myFunction(myParam: number[]): void {}
```

To populate the array with blocks, set the default value of the parameter as well.

```typescript-ignore
//% block="$myParam"
//% myParam.shadow="lists_create_with"
//% myParam.defl="inner_shadow_block"
function myFunction(myParam: number[]): void {}
```

The above will create a block that has an array by default with "inner_shadow_blocks" inside the array.

## Input formats

### Inline input

To make a block with multiple parameters appear as a single line, use `inlineInputMode`. The block will expand left to right instead of wrapping the parameter input across mulitple lines.

```typescript-ignore
//% block="magnitude of 3d vector at x %x and y %y and z %z"
//% inlineInputMode=inline
export function mag3d(x: number, y: number, z: number): number {
    return Math.sqrt(x * x + y * y + z * z);
}
```

**Playground example**: [Inline input](https://makecode.com/playground#https://makecode.com/playground#basic-inline)

### Expandable arguments

If your block has multiple parameters but some or all of them are likely to remain set to the default values, you can set the block as expandable. This simplifies the block and it appears shorter when unexpanded.

The portion of the block that is set to expand is separated by two field delimiters `||`. In the following example, the two optional parameters are separated from the first part of the block definition by `||`:

``//% block="play an alarm sound || of %sound for %duration ms"``

The `expandableArgumentMode` attribute controls how the expansion for the parameters will work. It is set to `toggle` in this example which will show the block collapsed with a **(+)** icon which expands the block when clicked.

```typescript-ignore
enum AlarmSound {
    //% block="annoy"
    Annoy,
    //% block="alert"
    Alert
}

//% color="#AA278D"
namespace alarms {
    /**
     * Play an alarm sound for some time
     * @param sound of the alarm to play, eg: AlarmSound.Annoy
     * @param duration of the alarm sound, eg: 2000
     */
    //% block="play an alarm sound || of %sound for %duration ms"
    //% duration.shadow=timePicker
    //% expandableArgumentMode="toggle"
    export function alarmSound(sound?: AlarmSound, duration?: number) {
    }
}
```

These are the settings for `expandableArgumentMode`:

* `toggle` - expand all parameters when the the expand icon is selected (clicked).
* `enabled` - expand one parameter at a time for each selection (click) of the expand icon.
* `disabled` - don't expand any parameters, keep the block collapsed. No icon is shown.

## Callbacks with Parameters

APIs that take in a callback function will have that callback converted into a statement input.
If the callback in the API is designed to take in parameters, the best way to map that pattern
to the blocks is by passing the callback a single parameter with a class type that contains
all the other values. For example:

```typescript-ignore
export class ArgumentClass {
    argumentA: number;
    argumentB: string;
}

//% mutate=objectdestructuring
//% mutateText="My Arguments"
//% mutateDefaults="argumentA;argumentA,argumentB"
// ...
export function addSomeEventHandler((a: ArgumentClass) => void) { };
```

In the above example, setting `mutate=objectdestructuring` will cause this API to use Blockly "mutators"
to let users change what parameters appear in the blocks. Each parameter will be given an
optional variable field in the block that defines a variable that can be used within the callback.
The variable fields compile to object destructuring in the TypeScript code. For example:

```typescript-ignore
addSomeEventHandler(({argumentA, argumentB}) => {

})
```

For an example of this pattern in action, see the `radio.onDataPacketReceived` block in
the microbit target.

In some cases it can be useful to change the runtime behavior of the API based on the properties selected by the
user. To enable that behavior, create an enum with entries that have the same names as the argument object's
properties and add an extra parameter taking in an enum array to the API. For example:

```typescript-ignore
export class ArgumentClass {
    argumentA: number;
    argumentB: string;
}

enum ArgNames {
    argumentA,
    argumentB
}

//% mutate=objectdestructuring
//% mutateText="My Arguments"
//% mutateDefaults="argumentA;argumentA,argumentB"
//% mutatePropertyEnum="argNames"
// ...
export function addSomeEventHandler(args: ArgNames[], (a: ArgumentClass) => void) { };
```

Note the `mutatePropertyEnum` attribute added to the comment annotations. The block for this API will
look the same as the previous example but the compiled code will also include the arguments passed:

```typescript-ignore
addSomeEventHandler([ArgNames.argumentA, ArgNames.argumentB], ({argumentA, argumentB}) => {

})
```

The other attributes related to object destructuring mutators include:

* `mutateText` - defines the text that appears in the top block of the Blockly mutator dialog (the dialog that appears when you click the blue gear)
* `mutateDefaults` - defines the versions of this block that should appear in the toolbox. Block definitions are separated by semicolons and property names should be separated by commas

**Playground examples**: [Functions](https://makecode.com/playground#functions), [Types of blocks](https://makecode.com/playground#basic-types), [Events](https://makecode.com/playground#events)

## Enums

Enum is supported and will automatically be represented by a dropdown in blocks.

```typescript-ignore
enum Button {
    A = 1,
    B = 2,
    //% blockId="ApB" block="A+B"
    AB = 3,
}
```

* the initializer can be used to map the value
* the `blockId` attribute can be used to override the block id
* the `block` attribute can be used to override the rendered string

### Tip: dropdown for non-enum parameters

It's possible to provide a drop-down for a parameter that is not an enum. It involves the following step:
* create an enum with desired drop down entry
```typescript-ignore
enum Delimiters {
    //% block="new line"
    NewLine = 1,
    //% block=","
    Comma = 2
}
```
* a function that takes the enum as parameter and returns the according value
```typescript-ignore
//% blockId="delimiter_conv" block="%del"
export function delimiters(del : Delimiters) : string {
    switch(del) {
        case Delimiters.NewLine: return "\n";
        case Delimiters.Comma:  return ",";
        ...
    }
}
```
* use the enum conversion function block id (``delimiter_conv``) as the value in the ``block`` parameter of your function
```typescript-ignore
//% blockId="read_until" block="read until %del=delimiter_conv"
export function readUntil(del: string) : string {
    ...
}
```


### Tip: using dropdowns for constants

Enums in TypeScript can be verbose, so sometimes it is desirable to compile a dropdown to a constant
variable rather than an enum member (for example, `Item.Shovel` could instead be `SHOVEL`).

To achieve this behavior, set `emitAsConstant` to true on an enum

```typescript
//% emitAsConstant
enum Item {
    //% block="Iron"
    Iron = 1
}
```

and then declare a constant for that enum member like so:

```typescript
//% enumIdentity="Item.Iron"
const IRON = Item.Iron;
```

If the enum has a shim function, you can also set `blockIdentity` just like you can for enum members. This
will make the decompiler will convert any instance of that constant into the block for that enum.

```typescript
//% emitAsConstant
enum Item {
    //% block="Iron"
    //% blockIdentity="blocks.item"
    Iron = 1
}

namespace blocks {
    //% shim=TD_ID
    //% blockId=minecraftItem
    //% block="item %item"
    function item(item: Item): number;
}

//% enumIdentity="Item.Iron"
//% blockIdentity="blocks.item"
const IRON = Item.Iron;
```

### Tip: implicit conversion for string parameters

If you have an API that takes a string as an argument it is possible to bypass the usual
type checking done in the blocks editor and allow any typed block to be placed in the input. PXT
will automatically convert whatever block is connected to the argument's input into a string
in the generated TypeScript. To enable that behavior, set `shadowOptions.toString` on the
parameter like so:

```
    //% blockId=console_log block="console|log %msg"
    //% text.shadowOptions.toString=true
    export function log(text: string): void {
        serial.writeString(text + "\r\n");
    }
```

Note that the parameter is referred to using its declared name (`text`) and not the
name in the block definition string (`msg`).

**Playground examples**: [Enumerations](https://makecode.com/playground#basic-enums)

### Creating enumerations with blocks

You can have blocks themselves define an enumeration dynamically. The block will specify some inital members but additional ones are added by selecting the "Add a new &lt;enum_name&gt;..." option in the parameter dropdown.

You first create a shadow block that defines the enumeration and has the initial members.

```typescript-ignore
//% shim=ENUM_GET
//% blockId=planet_enum_shim
//% block="Planet $arg"
//% enumName="Planets"
//% enumMemberName="planet"
//% enumPromptHint="e.g. Saturn, Mars, ..."
//% enumInitialMembers="Mecury, Venus, Earth"
export function _planetEnumShim(arg: number) {
    return arg;
}
```

This function will never actually appear in user code, it is just for defining the block.
To ensure that the function does not show up in intellisense add
an "_" to the beginning of its name.

All of the comment attributes shown in the example are required (including `shim`,
`blockId`, and `block`). The enum attributes work like this:

* `enumName` - The name of the enum. Must be a valid JavaScript identifier.
* `enumMemberName` - The name that will be used to refer to members of the enum in dialogs and on the block. This should be unique.
* `enumPromptHint` - The hint that will appear in the dialog for creating new members of the enum.
* `enumInitialMembers` - These are the enum values that are always added
to the project when this block is used. The first value is the default selection. It's comma or whitespace separated and all the members use
valid JavaScript identifiers. The list must have at least one value.
* `enumStartValue` (optional) - A positive integer that specifies the
lowest value that will be emitted when going from blocks to TypeScript.

Enums are emitted at the top of user code only if the block is used in the
project (or if it was used in the past). If the user changes the value of
the enum in TypeScript then those changes should persist when switching back to blocks.

When a function uses an enum shadow block, the incoming argument
should be of type `number` (don't use the `enum` type).

```typescript-ignore
//% blockId=planet_id
//% block="planet id from $planet"
//% planet.shadow="planet_enum_shim"
export function whatPlanet(planet: number): number{
    return planet;
}
```

**Playground example**: [Create Enums from Blocks](https://makecode.com/playground#language-create-enums)

## Docs and default values #jsdoc

The JSDoc comment is automatically used as the help for the block.
```typescript-ignore
/**
 * Scroll a number on the screen. If the number fits on the screen (i.e. is a single digit), do not scroll.
 * @param interval speed of scroll; eg: 150, 100, 200, -100
*/
//% help=functions/show-number
export function showNumber(value: number, interval: number = 150): void
{ }
```

* If `@param` annotation is available with an `eg:` section, the first
value is used as the shadow value.
* An optional `help` attribute can be used to point to an specific documentation path. To define custom help for extension blocks, see [GitHub Extension Authoring](/extensions/github-authoring).
* If the parameter has a default value (``interval`` in this case), it is **not** exposed in blocks.
* If you want to include minimum and maximum value range for a numeric parameter, you can use square brackets with the range [min-max] after the parameter name in the `@param` annotation. It is important to include the shadow value if you are using a range.
     - `@param` power [0-7] a value in the range 0..7, where 0 is the lowest power and 7 is the highest. `eg:` 7

## Objects and Instance methods

It is possible to expose instance methods and object factories, either directly
or with a bit of flattening (which is recommended, as flat, C-style APIs map best to blocks).

### Direct

```typescript-ignore
//%
class Message {
    ...
    //% blockId="message_get_text" block="%this|text"
    public getText() { ... }
}
```

* when annotating an instance method, you need to specify the ``%this`` parameter in the block syntax definition. It can be called something else, eg ``%msg``.

You will need to expose a factory method to create your objects as needed. For the example above, we add a function that creates the message:

```typescript-ignore
//% blockId="create_message" block="create message|with %text"
export function createMessage(text: string) : Message {
    return new Message(text);
}
```

### Auto-create

If object has a reasonable default constructor, and it is harmless to call this
constructor even if the variable needs to be overwritten later, then it's useful
to designate a parameter-less function as auto-create, like this:

```typescript-ignore
namespace images {
    export function emptyImage(width = 5, height = 5): Image { ... }
}
//% autoCreate=images.emptyImage
class Image {
    ...
}
```

Now, when user adds a block referring to a method of `Image`, a global
variable will be automatically introduced and initialized with `images.emptyImage()`.

In cases when the default constructor has side effects (eg., configuring a pin),
or if the default value is most often overridden,
the `autoCreate` syntax should not be used.

### Fixed Instance Set

It is sometimes the case that there is only a fixed number of instances
of a given class. One example is object representing pins on an electronic board.
It is possible to expose these instances in a manner similar to an enum:

```typescript-ignore
//% fixedInstances
//% blockNamespace=pins
class DigitalPin {
    ...
    //% blockId=device_set_digital_pin block="digital write|pin %name|to %value"
    digitalWrite(value: number): void { ... }
}

namespace pins {
    //% fixedInstance
    let D0: DigitalPin;
    //% fixedInstance
    let D1: DigitalPin;
}
```

This will result in a block `digital write pin [D0] to [0]`, where the
first hole is a dropdown with `D0` and `D1`, and the second hole is a regular
integer value. The variables `D0` and `D1` can have additional annotations
(eg., `block="D#0"`). Currently, only variables are supported with `fixedInstance`
(`let` or `const`).

Fixed instances also support inheritance. For example, consider adding the following
declarations.

```typescript-ignore
//% fixedInstances
class AnalogPin extends DigitalPin {
    ...
    //% blockId=device_set_analog_pin block="analog write|pin %name|to %value"
    //% blockNamespace=pins
    analogWrite(value: number): void { ... }
}

namespace pins {
    //% fixedInstance
    let A0: AnalogPin;
}
```

The `analog write` will have a single-option dropdown with `A0`, but
the optionals on `digital write` will be now `D0`, `D1` and `A0`.

Variables with `fixedInstance` annotations can be added anywhere, at the top-level,
even in different libraries or namespaces.

This feature is often used with `indexedInstance*` attributes.

The `blockNamespace` attribute specifies which drawer in the toolbox will
be used for this block. It can be specified on methods or on classes (to apply
to all methods in the class). Often, you will want to also set `color=...`,
also either on class or method.

It is also possible to define the instances to be used in blocks in TypeScript,
for example:

```typescript-ignore
namespace pins {
    //% fixedInstance whenUsed
    export const A7 = new AnalogPin(7);
}
```

The `whenUsed` annotation causes the variable to be only included in compilation
when it is used, even though it is initialized with something that can possibly
have side effects. This happens automatically when there is no initializer,
or the initializer is a simple constant, but for function calls and constructors
you have to include `whenUsed`.

### Properties

Fields and get/set accessors of classes defined in TypeScript can be exposed in blocks.
Typically, you want a single block for all getters for a given type, a single block
for setters, and possibly a single block for updates (compiling to the ``+=`` operator).
This can be done automatically with `//% blockCombine` annotation, for example:

```typescript
class Foo {
    //% blockCombine
    x: number;
    //% blockCombine
    y: number;
    // exposed with custom name
    //% blockCombine block="foo bar"
    foo_bar: number;

    // not exposed
    _bar: number;
    _qux: number;

    // exposed as read-only (only in the getter block)
    //% blockCombine
    get bar() { return this._bar }

    // exposed in both getter and setter
    //% blockCombine
    get qux() { return this._qux }
    //% blockCombine
    set qux(v: number) { if (v != 42) this._qux = v }
}
```

**Playground examples**: [Classes](https://makecode.com/playground#classes)

### Factories #factories

If you want a class instance created on demand rather than auto-creating or using a fixed instance, you can make a factory function to create the instance. This is typically a simple function that instantiates a class with the `new` operator and possibly passes some parameter values to the constructor as options.

```typescript
//% color="#FF8000"
namespace Widgets {
    export class Gizmo {
        _active: boolean;

        constructor(activate: boolean) {
            this._active = activate;
        }

        setInactive() {
            this._active = false;
        }
    }

    /**
     * Create a Gizmo widget and automtically set it to a variable
     */
    //% block="create gizmo"
    //% blockSetVariable=gizmo
    export function createGizmo(): Gizmo {
        return new Gizmo(true);
    }
}
```

To ensure there's a valid instance of the class when the block is used, the `blockSetVariable` attribute sets a variable to the new instance. In the example above, the `blockSetVariable` attribute will automatically create an instance of `Gizmo` and set the `gizmo` variable to it. The `gizmo` variable is created if it doesn't exist already. This allows a valid instance of `Gizmo` to be created by default when the block is pulled into the editor.

**Playground examples**: [Factories](https://makecode.com/playground#factories)

### Namespace attachment

If a class is defined outside a namespace but you want the blocks defined for its methods or properties associated with the namespace, you can attach the class to the namespace. At the beginning of the class definition, add an annotation with the `blockNamespace` attribute and set it to the name of the associated namespace. Using the class from the example in [Factories](#factories), the annotation might be:

``//% blockNamespace=Widgets color="#FF8000"``

This allows the blocks in the `Gizmo` class to appear together with the other blocks in the `Widgets` namespace in the editor. Notice also, that the `color` for the class is set to match the color of the `Widgets` blocks.

In this example, the `Gizmo` class from before is placed outside of the `Widgets` namespace. Also, the `setInactive` method is turned into a block so it appears along with other blocks in `Widgets`.

```typescript
//% blockNamespace=Widgets color="#FF8000"
class Gizmo {
    _active: boolean;

    constructor(activate: boolean) {
        this._active = activate;
    }

    /**
     * Set the Gizmo widget to inactive
     */
    //% block="set %Widgets(gizmo) to inactive"
    setInactive() {
        this._active = false;
    }
}

//% color="#FF8000"
namespace Widgets {

    /**
     * Create a Gizmo widget and automtically set it to a variable
     */
    //% block="create gizmo"
    //% blockSetVariable=gizmo
    export function createGizmo(): Gizmo {
        return new Gizmo(true);
    }
}
```

**Playground examples**: [Factories](https://makecode.com/playground#factories)

The `block` attribute for `setInactive` includes a reference to the `gizmo` variable created by the `createGizmo` factory function. This matches the block with a valid instance by default.

## Field editors

Field editors let you control how a parameter value is entered or selected. A field editor is a [shadow](#shadow-block) block that invokes the render of a selection UI element, dropdown list of items, or some other extended input method.

A field editor is attached to a parameter using the `shadow` attribute with the field editor name. In this example, a function to turn an LED on or off uses the `toggleOnOff` field editor to show a switch element as a block paramter.

```typescript-ignore
/**
* Toggle the LED on or off
*/
//% block="LED $on"
//% on.shadow="toggleOnOff"
export function ledOn(on: boolean) {

}
```

### Built-in field editors

There are ready made field editors that are built-in and available to use directly in your blocks:

* [Range](https://makecode.com/playground#field-editors-range)
* [Color Picker](https://makecode.com/playground#field-editors-color)
* [Toggle](https://makecode.com/playground#field-editors-toggle)
* [Time Picker](https://makecode.com/playground#field-editors-dropdowns)
* [Grid Picker](https://makecode.com/playground#field-editors-gridpicker)
* [Note](https://makecode.com/playground#field-editors-note)
* [Protractor](https://makecode.com/playground#field-editors-protractor)
* [Speed](https://makecode.com/playground#field-editors-speed)
* [Turn Ratio](https://makecode.com/playground#field-editors-turn-ratio)

### Custom field editor

If you want to create a custom field editor for you blocks then you need to define the shadow block for it. The `blockId` is the name that is used as the parameter `shadow` attribute.

Here's an example field editor for setting the score of a tennis game:

```typescript-ignore
/**
  * Get the score for a tennis score
  * @param score eg: 1
  */
//% blockId=tennisScore block="$score"
//% blockHidden=true
//% colorSecondary="#FFFFFF"
//% score.fieldEditor="numberdropdown" score.fieldOptions.decompileLiterals=true
//% score.fieldOptions.data='[["Love", 1], ["15", 2], ["30", 3], ["40", 4], ["Game", 5]]'
export function __tennisScore(score: number): number {
    return score;
}

//% block="set game score $score"
//% score.shadow="tennisScore"
export function setScore(score: number) {

}
```

The block is hidden by setting `blockHidden` to `true`. The `score` parameter has three attributes set for it:

* `fieldEditor` - the UI element used to select values.
* `fieldOptions.decompileLiterals` - set to `true`  to match values to their literal form.
* `fieldOptions.data` - a list of name to value matches for the selection dropdown.
> -- or --
* `fieldOptions.values` - a list of simple values to select from, like:
> ``vehicles.fieldOptions.values='[["truck"], ["airplane"], ["cruise ship"]]'``

**Playground example**: [Custom field editor](https://makecode.com/playground#field-editors-dropdowns)

## Ordering

All blocks have a default **weight** of 50 that is used to sort them in the UI with the highest weight showing up first. To tweak the [ordering](/playground#basic-ordering),
simply annotate the function with the ``weight`` macro:

```
//% weight=10
...
```

If given API is only for Blocks usage, and doesn't make much sense in TypeScript
(for example, because there are alternative TypeScript APIs), you can use ``//% hidden``
flag to disable showing it in auto-completion.

## Grouping

To put blocks into a previously defined group (see the [Category](/defining-blocks#category) section at the top of this page), use the `group` attribute.
The name of the group must match exactly one of the groups you've defined on your namespace.

> **Note**: When using the groups feature, block `weight` is only compared with weights of other blocks in the same group.

```
//% group="LED Matrix"
...
```

If you don't want to show labels, you can manually group blocks together using the **blockGap** macro. It lets you specify the distance between the current block and the next one in the toolbox.
Combined with the `weight` parameter, it allows you to visually group blocks together, essentially replicating the groups feature but without the labels. The default ``blockGap`` value is ``8``.

```
//% blockGap=14
...
```

## Variable assignment

If a block instantiates a custom object, like a sprite, it's most likely that the user
will want to store in a variable. Add ``blockSetVariable`` to modify the toolbox entry
to include the variable.

## Testing your Blocks

We recommend to build your block APIs iteratively and try it out in the editor to get the "feel of it".
To do so, the ideal setup is:
- run your target locally using ``pxt serve``
- keep a code editor with the TypeScript opened where you can edit the APIs
- refresh the browser and try out the changes on a dummy program.

Interestingly, you can design your entire API without implementing it!

## Deprecating Blocks

To deprecate an existing API, you can add the **deprecated** attribute like so:

```
//% deprecated=true
```

This will cause the API to still be usable in TypeScript, but prevent the block from appearing in the
Blockly toolbox. If a user tries to load a project that uses the old API, the project will still load
correctly as long as the TypeScript API is present. Any deprecated blocks in the project will appear in
the editor but not the toolbox.

## API design Tips and Tricks

A few tips gathered while designing various APIs for the Block Editor.

* **Design for beginners**: the block interface is for beginners. You'll want to create a specific layer of C-like function for that purpose.
* **Anything that snaps together will be tried by the user**: your runtime should deal with invalid input with graceful degradation rather than abrupt crashes.
Some users will try to snap anything together - get ready for it.
* **OO is cumbersome** in blocks: we recommend using a C-like APIs -- just function -- rather than OO classes. It maps better to blocks.
* **Keep the number of blocks small**: there's only so much space in the toolbox. Be specific about each API you want to see in Blocks.