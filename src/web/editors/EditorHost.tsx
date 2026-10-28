// Opens the right editor full screen (ADR-050, ADR-051). Each editor and its library (pdf.js,
// pdf-lib, mediabunny, CodeMirror, …) loads only now.
import { Component, lazy, Suspense, type ReactNode } from 'react';
import { t } from '../lib/i18n';
import type { EditRequest, Tool } from './files';
import { Busy, EditorFrame, Failed } from './ui';

const PhotoEditor = lazy(() =>
  import('./photo/PhotoEditor').then((m) => ({ default: m.PhotoEditor })),
);
const VideoEditor = lazy(() =>
  import('./video/VideoEditor').then((m) => ({ default: m.VideoEditor })),
);
const PdfEditor = lazy(() => import('./pdf/PdfEditor').then((m) => ({ default: m.PdfEditor })));
const TextEditor = lazy(() => import('./text/TextEditor').then((m) => ({ default: m.TextEditor })));
const DocEditor = lazy(() => import('./doc/DocEditor').then((m) => ({ default: m.DocEditor })));
const SheetEditor = lazy(() =>
  import('./sheet/SheetEditor').then((m) => ({ default: m.SheetEditor })),
);
const Compressor = lazy(() =>
  import('./compress/Compressor').then((m) => ({ default: m.Compressor })),
);
const Collage = lazy(() => import('./collage/Collage').then((m) => ({ default: m.Collage })));
const ZipViewer = lazy(() => import('./zip/ZipViewer').then((m) => ({ default: m.ZipViewer })));

const EDITORS: Record<Tool, typeof PhotoEditor> = {
  photo: PhotoEditor,
  video: VideoEditor,
  pdf: PdfEditor,
  text: TextEditor,
  doc: DocEditor,
  sheet: SheetEditor,
  zip: ZipViewer,
  compress: Compressor,
  collage: Collage,
};

/** A failed download of the editor (offline, or a new version of the app) shows a message. */
class Guard extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <EditorFrame title={t.editor.tools} onClose={this.props.onClose}>
        <Failed message={t.editor.cannotOpen} onClose={this.props.onClose} />
      </EditorFrame>
    );
  }
}

export function EditorHost({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const Editor = EDITORS[request.tool];
  return (
    <Guard onClose={onClose}>
      <Suspense
        fallback={
          <EditorFrame title={t.editor.tools} onClose={onClose}>
            <Busy label={t.common.loading} />
          </EditorFrame>
        }
      >
        <Editor request={request} onClose={onClose} />
      </Suspense>
    </Guard>
  );
}
