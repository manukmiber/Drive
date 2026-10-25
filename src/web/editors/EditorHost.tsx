// Opens the right editor full screen (ADR-050). Each editor and its library (pdf.js, pdf-lib,
// mediabunny) loads only now.
import { Component, lazy, Suspense, type ReactNode } from 'react';
import { t } from '../lib/i18n';
import type { EditRequest } from './files';
import { Busy, EditorFrame, Failed } from './ui';

const PhotoEditor = lazy(() =>
  import('./photo/PhotoEditor').then((m) => ({ default: m.PhotoEditor })),
);
const VideoEditor = lazy(() =>
  import('./video/VideoEditor').then((m) => ({ default: m.VideoEditor })),
);
const PdfEditor = lazy(() => import('./pdf/PdfEditor').then((m) => ({ default: m.PdfEditor })));

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
  const Editor =
    request.tool === 'photo' ? PhotoEditor : request.tool === 'video' ? VideoEditor : PdfEditor;
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
