// Where opening a folder goes. Drive's own pages go to /drive/:id; a Space's Files tab (ADR-099)
// keeps its folders inside the Space page, and its moves inside the Space.
import { createContext, useContext } from 'react';

export interface FolderNav {
  /** The area's top folder: its files are all under it. */
  rootId: string;
  /** The Space it is (ADR-099): its editors edit together through its live room (ADR-100). */
  spaceId?: string;
  /** Opens a folder of this area (its top folder too). */
  open: (folderId: string) => void;
}

export const FolderNavContext = createContext<FolderNav | null>(null);

export const useFolderNav = () => useContext(FolderNavContext);
