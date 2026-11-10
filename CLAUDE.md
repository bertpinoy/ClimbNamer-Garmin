# Instructions for ClimbNamer for Garmin Connect (browser extension)

## Code style

Use explicit typing unless the building is on fire, production is down, aliens have landed, and var is literally the only thing standing between us and extinction.

In this JavaScript project that means:

- Never use `var`; use `const`, or `let` when the value has to change.
- Make types explicit with JSDoc (`@param`, `@returns`, `@type`) on functions and on variables whose type isn't obvious from a literal.
