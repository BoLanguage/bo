const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const extensionRequire = createRequire(path.join(__dirname, "../vscode/package.json"));
const textmate = extensionRequire("vscode-textmate");
const oniguruma = extensionRequire("vscode-oniguruma");

async function main() {
    const wasm = fs.readFileSync(extensionRequire.resolve("vscode-oniguruma/release/onig.wasm"));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const file = path.join(__dirname, "../vscode/syntaxes/bo.tmLanguage.json");
    const registry = new textmate.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
            createOnigString: text => new oniguruma.OnigString(text),
        }),
        loadGrammar: async () => textmate.parseRawGrammar(fs.readFileSync(file, "utf8"), file),
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../vscode/package.json"), "utf8"));
    const config = manifest.contributes.grammars.find(g => g.scopeName === "source.bo");
    const grammar = await registry.loadGrammarWithConfiguration("source.bo", 1, {
        balancedBracketSelectors: config.balancedBracketScopes,
        unbalancedBracketSelectors: config.unbalancedBracketScopes,
    });

    function check(line, previous, selections) {
        const result = grammar.tokenizeLine(line, previous);
        for (const [offset, expected, excluded] of selections) {
            const token = result.tokens.find(t => t.startIndex <= offset && offset < t.endIndex);
            assert(token, `missing token: ${line} at ${offset}`);
            assert(token.scopes.includes(expected), `${line} at ${offset}: ${token.scopes}`);
            if (excluded) assert(!token.scopes.includes(excluded), `${line} at ${offset}: ${token.scopes}`);
        }
        return result.ruleStack;
    }

    const single = '; nop ( -- ) do nothing';
    check(single, null, [
        [single.indexOf("("), "comment.line.bo", "punctuation.section.list.bo"],
        [single.indexOf(")"), "comment.line.bo", "punctuation.section.list.bo"],
        [single.indexOf("nop"), "comment.line.bo", "support.function.bo"],
    ]);
    check('";" drop', null, [[0, "string.quoted.double.bo", "comment.line.bo"]]);
    check("(A) PUSH ; comment", null, [
        [0, "constant.language.bo", "comment.line.bo"],
        [9, "comment.line.bo", "punctuation.section.list.bo"],
    ]);
    check("(Stack.dup)", null, [
        [1, "constant.language.bo", "entity.name.type.error.bo"],
        [7, "constant.language.bo", "entity.name.type.error.bo"],
    ]);
    check("(Type-Error) ( Domain-Error ) (Disk-Full) Type-Error", null, [
        [0, "constant.language.bo", "entity.name.type.error.bo"],
        [1, "entity.name.type.error.bo", "keyword.control.bo"],
        [13, "constant.language.bo", "entity.name.type.error.bo"],
        [15, "entity.name.type.error.bo"],
        [28, "constant.language.bo", "entity.name.type.error.bo"],
        [30, "constant.language.bo", "entity.name.type.error.bo"],
        [42, "source.bo", "entity.name.type.error.bo"],
    ]);
    check("drop Stack.DROP Math.ADD Math.POW Value.WORD Value.TEXT", null, [
        [0, "keyword.control.bo", "entity.name.function.instructions.bo"],
        [11, "entity.name.function.instructions.bo", "keyword.control.bo"],
        [21, "entity.name.function.instructions.bo", "keyword.control.bo"],
        [30, "entity.name.function.instructions.bo", "keyword.control.bo"],
        [40, "entity.name.function.instructions.bo", "keyword.control.bo"],
        [51, "entity.name.function.instructions.bo", "keyword.control.bo"],
    ]);
    check("DROP PUSH map dup", null, [
        [0, "entity.name.function.instructions.bo", "keyword.control.bo"],
        [5, "entity.name.function.instructions.bo", "keyword.control.bo"],
        [10, "keyword.control.bo", "entity.name.function.instructions.bo"],
        [14, "keyword.control.bo", "entity.name.function.instructions.bo"],
    ]);
    check("A B (+) . .5 -> <- .. BROADCAST broadcast", null, [
        [8, "keyword.control.bo", "constant.numeric.bo"],
        [10, "constant.numeric.bo", "keyword.control.bo"],
        [13, "keyword.control.bo", "constant.numeric.bo"],
        [16, "keyword.control.bo", "constant.numeric.bo"],
        [19, "keyword.control.bo", "constant.numeric.bo"],
        [22, "entity.name.function.instructions.bo", "keyword.control.bo"],
        [32, "source.bo", "keyword.control.bo"],
    ]);
    check("List.unit Control.call Error.rethrow", null, [
        [0, "source.bo", "entity.name.type.error.bo"],
        [5, "keyword.control.bo", "entity.name.type.error.bo"],
        [10, "source.bo", "entity.name.type.error.bo"],
        [18, "keyword.control.bo", "entity.name.type.error.bo"],
        [23, "source.bo", "entity.name.type.error.bo"],
        [29, "keyword.control.bo", "entity.name.type.error.bo"],
    ]);
    check("__helper (__helper) A__b __a.b _a.b _x", null, [
        [0, "support.function.bo", "keyword.control.bo"],
        [10, "support.function.bo"],
        [10, "constant.language.bo"],
        [21, "source.bo", "support.function.bo"],
        [26, "support.function.bo"],
        [32, "source.bo", "support.function.bo"],
        [36, "source.bo", "support.function.bo"],
    ]);
    for (const [line, inside, outside] of [
        ['; nop ( -- )\n(A)', 6, 16],
    ]) {
        const tokens = grammar.tokenizeLine2(line).tokens;
        function metadata(offset) {
            let result;
            for (let i = 0; i < tokens.length && tokens[i] <= offset; i += 2)
                result = tokens[i + 1];
            return result;
        }
        assert.equal(metadata(inside) & 0x400, 0, `comment bracket: ${line}`);
        assert.notEqual(metadata(outside) & 0x400, 0, `code bracket: ${line}`);
    }
    console.log("VS Code TextMate comment scopes: OK");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
