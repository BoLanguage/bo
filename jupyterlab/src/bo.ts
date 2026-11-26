import { LanguageSupport, StreamLanguage, StringStream } from '@codemirror/language';

import { adapterNames, primitiveActions, primitiveNames } from './generated';


interface BoState {
  qualifier: string | null;
  qualifiedAction: boolean;
}


const number = /^[+-]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?$/;


function isDelimiter(character: string | undefined): boolean {
  if (character === undefined) {
    return true;
  }
  return /\s/.test(character) || '();"'.includes(character);
}


function readWord(stream: StringStream): string {
  let word = '';
  while (!stream.eol() && !isDelimiter(stream.peek())) {
    word += stream.next() ?? '';
  }
  return word;
}


function readString(stream: StringStream): void {
  stream.next();
  let escaped = false;
  while (!stream.eol()) {
    const character = stream.next() ?? '';
    if (character === '"' && !escaped) {
      return;
    }
    escaped = character === '\\' && !escaped;
    if (character !== '\\') {
      escaped = false;
    }
  }
}


const boLanguage = StreamLanguage.define<BoState>({
  startState: () => ({ qualifier: null, qualifiedAction: false }),
  token: (stream, state) => {
    if (state.qualifiedAction) {
      if (stream.peek() === '.') {
        stream.next();
        return 'punctuation';
      }
      const action = readWord(stream);
      state.qualifiedAction = false;
      const qualified = state.qualifier === null ? null : `${state.qualifier}.${action}`;
      state.qualifier = null;
      return primitiveActions.has(action) || (qualified !== null && adapterNames.has(qualified))
        ? 'keyword'
        : 'variableName';
    }
    if (stream.eatSpace()) {
      return null;
    }
    const character = stream.peek() ?? '';
    if (character === ';') {
      stream.skipToEnd();
      return 'comment';
    }
    if (character === '"') {
      readString(stream);
      return 'string';
    }
    if (character === '(' || character === ')') {
      stream.next();
      return 'punctuation';
    }
    const word = readWord(stream);
    if (word.startsWith('__')) {
      return 'variableName.special';
    }
    if (word && stream.peek() === '.') {
      state.qualifier = word;
      state.qualifiedAction = true;
      return 'typeName';
    }
    if (number.test(word)) {
      return 'number';
    }
    return adapterNames.has(word) || primitiveNames.has(word) ? 'keyword' : 'variableName';
  }
});


export function bo(): LanguageSupport {
  return new LanguageSupport(boLanguage);
}
