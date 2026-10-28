// Placeholder until the collage tool lands in its own commit (ADR-067).
import { t } from '../../lib/i18n';
import type { EditRequest } from '../files';
import { EditorFrame, Failed } from '../ui';

export function Collage({ onClose }: { request: EditRequest; onClose: () => void }) {
  return (
    <EditorFrame title={t.editor.tools} onClose={onClose}>
      <Failed message={t.editor.cannotOpen} onClose={onClose} />
    </EditorFrame>
  );
}
