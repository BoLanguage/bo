# BoLang for VS Code

This folder contains a syntax-highlighting extension for `.bo` files.
Run `python3 tools/generate_vscode_grammar.py` from the repository root after
changing runtime primitives or library definitions in `include/core.bo` or the other `include/*.bo` modules; `--check` verifies the committed
grammar and JupyterLab token data are current.

Run `make vsix` (or `make all`) from the repository root to package the extension as `vscode/bolang-<VERSION>.vsix`, whose version comes from the `VERSION` file; install it manually, for example with `code --install-extension vscode/bolang-<VERSION>.vsix`.

Syntax highlighting for [Bo](https://github.com/BoLanguage/bo) (`.bo` files): semicolon comments, strings, numbers, conversion primitives `SELECTOR` and `NAME`, parentheses, definition primitives (`PUSH`, `LOCK`, ...), and control ops (`ifte`, `loop`, `catch`, ...). Colors depend on the active theme.

A string spanning several lines is highlighted as a comment, since that is what it is in practice. A list comment must fit on one line; it may contain nested parentheses and strings. Parentheses inside comments have the comment scope and are excluded from VS Code's built-in bracket-pair coloring; the `drop` op is highlighted separately as a control op.

Colors are not defined by the extension but by your color theme: the grammar (`vscode/syntaxes/bo.tmLanguage.json`) labels tokens with scopes such as `constant.numeric.bo`, `comment.line.bo`, `entity.name.type.error.bo` (the kernel's error kinds written as units, such as `(Type-Error)`), `keyword.control.bo`, `keyword.other.definition.bo`, `support.function.bo` (private ops starting with `__`, see private ops in the language guide), `string.quoted.double.bo`, and `punctuation.section.list.bo`. Dots remain ordinary op-name characters. To change a color without touching the extension, add to your VS Code `settings.json`:

```
"editor.tokenColorCustomizations": {
    "textMateRules": [
        { "scope": "constant.numeric.bo", "settings": { "foreground": "#d4d4d4" } }
    ]
}
```

Use the foreground of normal text to make numbers look uncolored. "Developer: Inspect Editor Tokens and Scopes" shows the scope under the cursor. To remove a token class for everyone, delete its rule from the `patterns` list of the grammar.


## Install locally

Either copy this folder to `~/.vscode/extensions/bolang` and restart VS Code, or build and install a package:

```
npx @vscode/vsce package
code --install-extension bolang-0.5.1.vsix
```

(or use Extensions, `...`, "Install from VSIX"). Alternatively copy the folder to `~/.vscode/extensions/bolang` and restart VS Code. The `.vsix` can also be attached to a GitHub release.
