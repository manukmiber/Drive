// A folder's icon in its colour (ADR-058): one emoji, one of the fixed lucide icons, or the plain
// folder. The colour comes as two CSS variables and `.decor-color` picks the shade for the theme.
import {
  Archive,
  Baby,
  BookOpen,
  Briefcase,
  Camera,
  Code,
  Dumbbell,
  FileText,
  Film,
  Folder,
  Gamepad2,
  GraduationCap,
  Heart,
  House,
  Image,
  Lock,
  Music,
  PawPrint,
  Plane,
  Receipt,
  ShoppingBag,
  Star,
  Utensils,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import {
  FOLDER_COLORS,
  isIconName,
  isOneEmoji,
  type FolderColor,
  type FolderIconName,
} from '../../shared/folder-decor';
import { cn } from '../lib/cn';

export const DECOR_ICONS: Record<FolderIconName, LucideIcon> = {
  folder: Folder,
  star: Star,
  heart: Heart,
  briefcase: Briefcase,
  'graduation-cap': GraduationCap,
  'book-open': BookOpen,
  camera: Camera,
  image: Image,
  music: Music,
  film: Film,
  'file-text': FileText,
  code: Code,
  'gamepad-2': Gamepad2,
  plane: Plane,
  house: House,
  'shopping-bag': ShoppingBag,
  wallet: Wallet,
  receipt: Receipt,
  baby: Baby,
  'paw-print': PawPrint,
  dumbbell: Dumbbell,
  utensils: Utensils,
  lock: Lock,
  archive: Archive,
};

export function decorVars(color: FolderColor | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  const c = FOLDER_COLORS[color];
  return { '--dl': c.light, '--dd': c.dark } as CSSProperties;
}

export function FolderGlyph({
  color,
  icon,
  className = 'h-5 w-5',
}: {
  color?: FolderColor | null;
  icon?: string | null;
  className?: string;
}) {
  if (icon && isOneEmoji(icon))
    return (
      // An SVG box, so an emoji sizes with the same classes as the icons beside it.
      <svg viewBox="0 0 24 24" className={cn(className, 'shrink-0')} aria-hidden="true">
        <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fontSize="19">
          {icon}
        </text>
      </svg>
    );
  const Icon = icon && isIconName(icon) ? DECOR_ICONS[icon] : Folder;
  return (
    <Icon
      aria-hidden="true"
      className={cn(className, 'shrink-0', color ? 'decor-color' : 'text-brand-600')}
      style={decorVars(color)}
    />
  );
}
