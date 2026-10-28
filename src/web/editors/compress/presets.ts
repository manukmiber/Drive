// Ready-made settings for the local compressor (ADR-067), like HandBrake's presets. "custom" is
// whatever the Video and Audio tabs say.
import { DEFAULT_SETTINGS, type EncodeSettings } from '../codecs/media';

export type PresetId =
  | 'fast1080'
  | 'hq1080'
  | 'hevc1080'
  | 'fast720'
  | 'small480'
  | 'send25'
  | 'send10'
  | 'av1'
  | 'vp9'
  | 'audioMp3'
  | 'audioM4a'
  | 'custom';

const base = DEFAULT_SETTINGS;
const mp4 = (
  video: Partial<EncodeSettings['video']>,
  audio: Partial<EncodeSettings['audio']> = {},
): EncodeSettings => ({
  container: 'mp4',
  video: { ...base.video, ...video },
  audio: { ...base.audio, ...audio },
});

export const PRESETS: Record<Exclude<PresetId, 'custom'>, EncodeSettings> = {
  fast1080: mp4({ codec: 'avc', rf: 22, height: 1080 }, { bitrate: 160 }),
  hq1080: mp4({ codec: 'avc', rf: 19, height: 1080 }, { bitrate: 192 }),
  hevc1080: mp4({ codec: 'hevc', rf: 27, height: 1080 }, { bitrate: 160 }),
  fast720: mp4({ codec: 'avc', rf: 23, height: 720, fps: 30 }, { bitrate: 128 }),
  small480: mp4({ codec: 'avc', rf: 26, height: 480, fps: 30 }, { bitrate: 96 }),
  send25: mp4({ codec: 'avc', rate: 'size', sizeMb: 25, height: 720, fps: 30 }, { bitrate: 96 }),
  send10: mp4({ codec: 'avc', rate: 'size', sizeMb: 10, height: 480, fps: 30 }, { bitrate: 64 }),
  av1: {
    container: 'webm',
    video: { ...base.video, codec: 'av1', rf: 34, height: 1080 },
    audio: { ...base.audio, codec: 'opus', bitrate: 128 },
  },
  vp9: {
    container: 'webm',
    video: { ...base.video, codec: 'vp9', rf: 33, height: 1080 },
    audio: { ...base.audio, codec: 'opus', bitrate: 128 },
  },
  audioMp3: {
    container: 'mp3',
    video: base.video,
    audio: { ...base.audio, codec: 'mp3', bitrate: 192 },
  },
  audioM4a: {
    container: 'm4a',
    video: base.video,
    audio: { ...base.audio, codec: 'aac', bitrate: 160 },
  },
};

export const PRESET_IDS = [...(Object.keys(PRESETS) as PresetId[]), 'custom' as const];

