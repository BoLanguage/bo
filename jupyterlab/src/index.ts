import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { IEditorLanguageRegistry } from '@jupyterlab/codemirror';

import { bo } from './bo';


const plugin: JupyterFrontEndPlugin<void> = {
  id: 'bo-jupyterlab:language',
  autoStart: true,
  requires: [IEditorLanguageRegistry],
  activate: (_app: JupyterFrontEnd, languages: IEditorLanguageRegistry) => {
    languages.addLanguage({
      name: 'bo',
      displayName: 'Bo',
      alias: ['BoLang'],
      mime: 'text/x-bo',
      extensions: ['bo'],
      load: async () => bo()
    });
  }
};

export default plugin;
