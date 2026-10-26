// A folder's colour and icon as inline SVG for the server-rendered share pages (ADR-058). The icon
// paths are lucide's own, read from the same package the app draws them with.
import {
  FOLDER_COLORS,
  isFolderColor,
  isIconName,
  isOneEmoji,
  type FolderIconName,
} from '../../shared/folder-decor';
import { escapeHtml } from '../services/email-templates';
import { __iconData as folder } from 'lucide-react/dist/esm/icons/folder.mjs';
import { __iconData as star } from 'lucide-react/dist/esm/icons/star.mjs';
import { __iconData as heart } from 'lucide-react/dist/esm/icons/heart.mjs';
import { __iconData as briefcase } from 'lucide-react/dist/esm/icons/briefcase.mjs';
import { __iconData as graduationCap } from 'lucide-react/dist/esm/icons/graduation-cap.mjs';
import { __iconData as bookOpen } from 'lucide-react/dist/esm/icons/book-open.mjs';
import { __iconData as camera } from 'lucide-react/dist/esm/icons/camera.mjs';
import { __iconData as image } from 'lucide-react/dist/esm/icons/image.mjs';
// lucide's `music` is an alias module that re-exports `eighth-notes` without its data.
import { __iconData as music } from 'lucide-react/dist/esm/icons/eighth-notes.mjs';
import { __iconData as film } from 'lucide-react/dist/esm/icons/film.mjs';
import { __iconData as fileText } from 'lucide-react/dist/esm/icons/file-text.mjs';
import { __iconData as code } from 'lucide-react/dist/esm/icons/code.mjs';
import { __iconData as gamepad2 } from 'lucide-react/dist/esm/icons/gamepad-2.mjs';
import { __iconData as plane } from 'lucide-react/dist/esm/icons/plane.mjs';
import { __iconData as house } from 'lucide-react/dist/esm/icons/house.mjs';
import { __iconData as shoppingBag } from 'lucide-react/dist/esm/icons/shopping-bag.mjs';
import { __iconData as wallet } from 'lucide-react/dist/esm/icons/wallet.mjs';
import { __iconData as receipt } from 'lucide-react/dist/esm/icons/receipt.mjs';
import { __iconData as baby } from 'lucide-react/dist/esm/icons/baby.mjs';
import { __iconData as pawPrint } from 'lucide-react/dist/esm/icons/paw-print.mjs';
import { __iconData as dumbbell } from 'lucide-react/dist/esm/icons/dumbbell.mjs';
import { __iconData as utensils } from 'lucide-react/dist/esm/icons/utensils.mjs';
import { __iconData as lock } from 'lucide-react/dist/esm/icons/lock.mjs';
import { __iconData as archive } from 'lucide-react/dist/esm/icons/archive.mjs';

type IconNode = Array<[string, Record<string, string>]>;

const ICONS: Record<FolderIconName, { node: IconNode }> = {
  folder,
  star,
  heart,
  briefcase,
  'graduation-cap': graduationCap,
  'book-open': bookOpen,
  camera,
  image,
  music,
  film,
  'file-text': fileText,
  code,
  'gamepad-2': gamepad2,
  plane,
  house,
  'shopping-bag': shoppingBag,
  wallet,
  receipt,
  baby,
  'paw-print': pawPrint,
  dumbbell,
  utensils,
  lock,
  archive,
};

function svg(node: IconNode): string {
  const parts = node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts}</svg>`;
}

/**
 * The badge before a shared folder's title: its icon (or emoji) in its colour. Empty when the folder
 * has neither. Never a cover image: a share page has no session to check one against.
 */
export function folderBadge(color: string | null, icon: string | null): string {
  const c = color && isFolderColor(color) ? FOLDER_COLORS[color] : null;
  if (!c && !icon) return '';
  const glyph =
    icon && isOneEmoji(icon)
      ? `<span aria-hidden="true">${escapeHtml(icon)}</span>`
      : svg(ICONS[icon && isIconName(icon) ? icon : 'folder'].node);
  const style = c ? ` style="--dl:${c.light};--dd:${c.dark}"` : '';
  return `<span class="decor"${style}>${glyph}</span>`;
}
