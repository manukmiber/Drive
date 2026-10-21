// CsamDetector adapter (SPEC §14.3). Real providers (Hive, Thorn Safer, PhotoDNA) need vendor
// agreements; until then the mock never matches.
export interface CsamCheck {
  match: boolean;
  provider: string;
  ref: string | null;
}

export interface CsamDetector {
  readonly name: string;
  checkImage(input: { key: string; mime: string }): Promise<CsamCheck>;
}

export class MockCsamDetector implements CsamDetector {
  readonly name = 'mock';
  async checkImage(): Promise<CsamCheck> {
    return { match: false, provider: 'mock', ref: null };
  }
}
