import { Note } from '.';
import type { Clip } from '.';
import { stringify } from 'flatted';

export function assertNotesAreEqual(notes1: Note[], notes2: Note[]) {
  if (notes1.length !== notes2.length) {
    throw new Error(`Notes are not of equal length, ${notes1.length} vs ${notes2.length}`);
  }
  for (let i = 0; i < notes1.length; i += 1) {
    if (!notes1[i].equals(notes2[i])) {
      throw new Error(
        `${i}th notes of the two lists are not equal, \n${stringify(notes1[i])}\n vs \n${stringify(
          notes2[i],
        )}`,
      );
    }
  }
}

export function createTestNotes(noteSpecs: any[], clip: Clip) {
  return noteSpecs.map(
    item =>
      new Note({
        ...item,
        clip,
      }),
  );
}

export function assertClipRange(clip: Clip, startTick: number, endTick: number) {
  expect(clip.getClipStartTick()).toBe(startTick);
  expect(clip.getClipEndTick()).toBe(endTick);
}
