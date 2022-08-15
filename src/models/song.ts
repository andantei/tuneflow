import { ge as greaterEqual, lt as lowerThan } from 'binary-search-bounds';
import cloneDeep from 'lodash.clonedeep';
import * as _ from 'underscore';
import type { TuneflowPlugin } from '../base_plugin';
import { TempoEvent } from './tempo';
import { TimeSignatureEvent } from './time_signature';
import { Track, TrackType } from './track';
import { Midi } from '@tonejs/midi';
import { AutomationTarget, AutomationTargetType } from './automation';
import type { AutomationValue } from './automation';

export class Song {
  private tracks: Track[];
  private PPQ: number;
  private tempos: TempoEvent[];
  private timeSignatures: TimeSignatureEvent[];
  private pluginContext?: PluginContext;
  private nextTrackRank = 1;

  constructor() {
    this.tracks = [];
    this.PPQ = 0;
    this.tempos = [];
    this.timeSignatures = [];
  }

  /**
   * @returns All tracks in previously stored order.
   */
  getTracks(): Track[] {
    return this.tracks;
  }

  getTrackById(trackId: string) {
    return _.find(this.tracks, track => track.getId() === trackId);
  }

  getTracksByIds(trackIds: string[]) {
    if (!this.tracks) {
      return [];
    }
    const trackIdSet = new Set<string>(trackIds);
    return this.tracks.filter(track => trackIdSet.has(track.getId()));
  }

  /**
   * Get the index of the track within the tracks list.
   * Returns -1 if no track matches the track id.
   */
  getTrackIndex(trackId: string) {
    return _.findIndex(this.tracks, track => track.getId() === trackId);
  }

  /**
   * Adds a new track into the song and returns it.
   *
   * Requires `createTrack` access.
   */
  createTrack({
    type,
    index,
    rank,
  }: {
    type: TrackType;
    /** Index to insert at. If left blank, appends to the end. */
    index?: number;
    /** The displayed rank which uniquely identifies a track. Internal use, do not set this. */
    rank?: number;
  }): Track {
    this.checkAccess('createTrack');
    if (rank == undefined || rank === null) {
      rank = this.getNextTrackRank();
    } else {
      this.nextTrackRank = Math.max(rank + 1, this.nextTrackRank);
    }
    const track = new Track({
      type,
      song: this,
      uuid: this.getNextTrackId(),
      rank: rank == undefined || rank === null ? this.getNextTrackRank() : rank,
    });
    if (index !== undefined && index !== null) {
      this.tracks.splice(index, 0, track);
    } else {
      this.tracks.push(track);
    }
    return track;
  }

  /**
   * Clones a track and inserts it in this song and returns the cloned instance.
   * @param track The track in this song to clone.
   * @returns The cloned track.
   */
  cloneTrack(track: Track) {
    let trackIndex: any = this.getTrackIndex(track.getId());
    if (trackIndex < 0) {
      // Track not found in this song, new track will be inserted at the end.
      trackIndex = undefined;
    }
    const newTrack = this.createTrack({
      type: track.getType(),
      index: trackIndex,
    });
    newTrack.setVolume(track.getVolume());
    newTrack.setPan(track.getPan());
    newTrack.setSolo(track.getSolo());
    newTrack.setMuted(track.getMuted());
    if (track.getType() === TrackType.MIDI_TRACK) {
      const trackInstrument = track.getInstrument();
      if (trackInstrument) {
        newTrack.setInstrument({
          program: trackInstrument.getProgram(),
          isDrum: trackInstrument.getIsDrum(),
        });
      }

      for (const existingInstrument of track.getSuggestedInstruments()) {
        newTrack.createSuggestedInstrument({
          program: existingInstrument.getProgram(),
          isDrum: existingInstrument.getIsDrum(),
        });
      }

      const existingSamplerPlugin = track.getSamplerPlugin();
      if (existingSamplerPlugin) {
        newTrack.setSamplerPlugin(existingSamplerPlugin.clone(newTrack));
      }
    } else if (track.getType() === TrackType.AUDIO_TRACK) {
      // No-op.
    }

    for (const audioPlugin of track.getAudioPlugins()) {
      newTrack.addAudioPlugin(audioPlugin.clone(newTrack));
    }
    for (const clip of track.getClips()) {
      const newClip = newTrack.cloneClip(clip);
      newTrack.insertClip(newClip);
    }
    return newTrack;
  }

  /**
   * Removes a new track from the song and returns it.
   *
   * Requires `removeTrack` access.
   */
  removeTrack(trackId: string) {
    this.checkAccess('removeTrack');
    const track = this.getTrackById(trackId);
    if (!track) {
      return null;
    }
    this.tracks.splice(
      _.findIndex(this.tracks, track => track.getId() === trackId),
      1,
    );
    return track;
  }

  /**
   * @returns The resolution of the song in Pulse-per-quarter.
   */
  getResolution(): number {
    return this.PPQ;
  }

  getBeatsPerBar() {
    return this.getTimeSignatures()[0].getNumerator();
  }

  getTicksPerBar() {
    return this.getBeatsPerBar() * this.getResolution();
  }

  /**
   * Sets resolution in Pulse-per-quarter.
   * @param resolution
   */
  setResolution(resolution: number) {
    this.PPQ = resolution;
  }

  /**
   * @returns A list of tempo change events ordered by occurrence time.
   */
  getTempoChanges(): TempoEvent[] {
    return this.tempos;
  }

  /**
   * Adds a tempo change event into the song and returns it.
   * @returns
   */
  createTempoChange({
    ticks,
    bpm,
  }: {
    /** The tick at which this event happens. */
    ticks: number;
    /** The new tempo in BPM(Beats-per-minute) format. */
    bpm: number;
  }): TempoEvent {
    if (this.PPQ <= 0) {
      throw new Error('Song resolution must be provided before creating tempo changes.');
    }
    if (this.tempos.length === 0 && ticks !== 0) {
      throw new Error('The first tempo event must be at tick 0');
    }
    // Calculate time BEFORE the new tempo event is inserted.
    const tempoChange = new TempoEvent({ ticks, bpm, time: this.tickToSeconds(ticks) });
    const insertIndex = greaterEqual(
      this.tempos,
      tempoChange,
      (a: TempoEvent, b: TempoEvent) => a.getTicks() - b.getTicks(),
    );
    if (insertIndex < 0) {
      this.tempos.push(tempoChange);
    } else {
      this.tempos.splice(insertIndex, 0, tempoChange);
    }
    this.retimingTempoEvents();
    return tempoChange;
  }

  /**
   * Overwrite the existing tempo changes with the new tempo changes. Tempo times will be re-calculated.
   *
   * You can omit time in the new `TempoEvent`s since we'll re-calculate them altogether.
   *
   * Note that the new tempo events must have one tempo event starting at tick 0.
   * @param tempoEvents
   */
  overwriteTempoChanges(tempoEvents: TempoEvent[]) {
    if (tempoEvents.length === 0) {
      throw new Error('Cannot clear all the tempo events.');
    }
    const sortedTempoEvents = cloneDeep(tempoEvents);
    sortedTempoEvents.sort((a, b) => a.getTicks() - b.getTicks());
    const firstTempoEvent = sortedTempoEvents[0];
    if (firstTempoEvent.getTicks() > 0) {
      throw new Error('The first tempo event needs to start from tick 0');
    }
    this.tempos = [
      new TempoEvent({
        ticks: 0,
        time: 0,
        bpm: firstTempoEvent.getBpm(),
      }),
    ];
    for (let i = 1; i < sortedTempoEvents.length; i += 1) {
      const tempoEvent = sortedTempoEvents[i];
      this.createTempoChange({
        ticks: tempoEvent.getTicks(),
        bpm: tempoEvent.getBpm(),
      });
    }
  }

  /**
   * Overwrite all existing time signatures with the given new time signatures.
   * @param timeSignatures
   */
  overwriteTimeSignatures(timeSignatures: TimeSignatureEvent[]) {
    this.timeSignatures = cloneDeep(timeSignatures);
  }

  updateTempo(tempoEvent: TempoEvent, newBPM: number) {
    tempoEvent.setBpmInternal(newBPM);
    this.retimingTempoEvents();
  }

  getTimeSignatures(): TimeSignatureEvent[] {
    return this.timeSignatures;
  }

  createTimeSignature({
    ticks,
    numerator,
    denominator,
  }: {
    /** The tick at which this event happens. */
    ticks: number;
    numerator: number;
    denominator: number;
  }): TimeSignatureEvent {
    const timeSignature = new TimeSignatureEvent({ ticks, numerator, denominator });
    const insertIndex = greaterEqual(
      this.timeSignatures,
      timeSignature,
      (a: TimeSignatureEvent, b: TimeSignatureEvent) => a.getTicks() - b.getTicks(),
    );
    if (insertIndex < 0) {
      this.timeSignatures.push(timeSignature);
    } else {
      this.timeSignatures.splice(insertIndex, 0, timeSignature);
    }
    return timeSignature;
  }

  /**
   *
   * @returns End tick of the last note.
   */
  getLastTick() {
    let lastTick = 0;

    for (const track of this.tracks) {
      lastTick = Math.max(lastTick, track.getTrackEndTick());
    }
    return lastTick;
  }

  /**
   * @returns Total duration of the song in seconds.
   */
  getDuration() {
    return this.tickToSeconds(this.getLastTick());
  }

  /**
   * This is the measurement for drawing beats based on the time signature.
   * This should not be used to calculate timing info, for that purpose, use
   * `getResolution()` instead which is the number of ticks per quater note.
   */
  getTicksPerBeat() {
    return this.getResolution() * (4 / this.getTimeSignatures()[0].getDenominator());
  }

  tickToSeconds(tick: number) {
    return Song.tickToSecondsImpl(tick, this.getTempoChanges(), this.getResolution());
  }

  static tickToSecondsImpl(tick: number, tempos: TempoEvent[], resolution: number) {
    if (tick === 0) {
      return 0;
    }
    let baseTempoIndex = lowerThan(
      tempos,
      // @ts-ignore
      { getTicks: () => tick },
      (a, b) => a.getTicks() - b.getTicks(),
    );
    if (baseTempoIndex == -1) {
      // If no tempo is found before the tick, use the first tempo.
      baseTempoIndex = 0;
    }
    const baseTempoChange = tempos[baseTempoIndex];
    const ticksDelta = tick - baseTempoChange.getTicks();
    const ticksPerSecondSinceLastTempoChange = Song.tempoBPMToTicksPerSecond(
      baseTempoChange.getBpm() as number,
      resolution,
    );
    return baseTempoChange.getTime() + ticksDelta / ticksPerSecondSinceLastTempoChange;
  }

  secondsToTick(seconds: number) {
    if (seconds === 0) {
      return 0;
    }
    let baseTempoIndex = lowerThan(
      this.getTempoChanges(),
      // @ts-ignore
      { getTime: () => seconds },
      (a, b) => a.getTime() - b.getTime(),
    );
    if (baseTempoIndex == -1) {
      // If no tempo is found before the time, use the first tempo.
      baseTempoIndex = 0;
    }
    const baseTempoChange = this.getTempoChanges()[baseTempoIndex];
    const timeDelta = seconds - baseTempoChange.getTime();
    const ticksPerSecondSinceLastTempoChange = Song.tempoBPMToTicksPerSecond(
      baseTempoChange.getBpm(),
      this.getResolution(),
    );
    return Math.round(baseTempoChange.getTicks() + timeDelta * ticksPerSecondSinceLastTempoChange);
  }

  static importMIDI(
    song: Song,
    fileBuffer: ArrayBuffer,
    insertAtTick = 0,
    overwriteTemposAndTimeSignatures = false,
  ) {
    const midi = new Midi(fileBuffer);
    const insertOffset = insertAtTick;
    // For songs that are not 480 PPQ, we need to convert the ticks
    // so that the beats and time remain unchanged.
    const ppqScaleFactor = 480 / midi.header.ppq;
    // Optionally overwrite tempos and time signatures.
    if (overwriteTemposAndTimeSignatures) {
      // Time signatures need to be imported before tempos.
      const newTimeSignatureEvents = [];
      for (const rawTimeSignatureEvent of midi.header.timeSignatures) {
        newTimeSignatureEvents.push(
          new TimeSignatureEvent({
            ticks: insertOffset + scaleIntBy(rawTimeSignatureEvent.ticks, ppqScaleFactor),
            numerator: rawTimeSignatureEvent.timeSignature[0],
            denominator: rawTimeSignatureEvent.timeSignature[1],
          }),
        );
      }
      song.overwriteTimeSignatures(newTimeSignatureEvents);
      const newTempoEvents = [];
      if (insertOffset > 0) {
        // Insert a default tempo event at the beginning.
        newTempoEvents.push(
          new TempoEvent({
            ticks: 0,
            time: 0,
            bpm: 120,
          }),
        );
      }
      for (const rawTempoEvent of midi.header.tempos) {
        newTempoEvents.push(
          new TempoEvent({
            ticks: insertOffset + scaleIntBy(rawTempoEvent.ticks, ppqScaleFactor),
            time: rawTempoEvent.time as number,
            bpm: rawTempoEvent.bpm,
          }),
        );
      }
      song.overwriteTempoChanges(newTempoEvents);
    }

    // Add tracks and notes.
    for (const track of midi.tracks) {
      const songTrack = song.createTrack({ type: TrackType.MIDI_TRACK });
      songTrack.setInstrument({
        program: track.instrument.number,
        isDrum: track.instrument.percussion,
      });
      const trackClip = songTrack.createMIDIClip({ clipStartTick: insertOffset });
      let minStartTick = Number.MAX_SAFE_INTEGER;
      // Add notes.
      for (const note of track.notes) {
        trackClip.createNote({
          pitch: note.midi,
          velocity: Math.round(note.velocity * 127),
          startTick: insertOffset + scaleIntBy(note.ticks, ppqScaleFactor),
          endTick: insertOffset + scaleIntBy(note.ticks + note.durationTicks, ppqScaleFactor),
        });
        minStartTick = Math.min(
          minStartTick,
          insertOffset + scaleIntBy(note.ticks, ppqScaleFactor),
        );
      }
      // Add volume automation.
      if (track.controlChanges[7]) {
        const volumeTarget = new AutomationTarget(AutomationTargetType.VOLUME);
        songTrack.getAutomation().addAutomation(volumeTarget);
        const volumeTargetValue = songTrack
          .getAutomation()
          .getAutomationValueByTarget(volumeTarget) as AutomationValue;
        for (const cc of track.controlChanges[7]) {
          volumeTargetValue.addPoint(insertOffset + scaleIntBy(cc.ticks, ppqScaleFactor), cc.value);
        }
      }
      // Add pan automation.
      if (track.controlChanges[10]) {
        const panTarget = new AutomationTarget(AutomationTargetType.PAN);
        songTrack.getAutomation().addAutomation(panTarget);
        const panTargetValue = songTrack
          .getAutomation()
          .getAutomationValueByTarget(panTarget) as AutomationValue;
        for (const cc of track.controlChanges[10]) {
          panTargetValue.addPoint(insertOffset + scaleIntBy(cc.ticks, ppqScaleFactor), cc.value);
        }
      }
      if (minStartTick !== Number.MAX_SAFE_INTEGER) {
        trackClip.adjustClipLeft(minStartTick);
      }
    }
  }

  protected setPluginContextInternal(plugin: TuneflowPlugin) {
    this.pluginContext = {
      plugin,
      numTracksCreatedByPlugin: 0,
    };
  }

  protected clearPluginContextInternal() {
    this.pluginContext = undefined;
  }

  private getNextTrackId() {
    const pluginContext = this.pluginContext as PluginContext;
    // @ts-ignore
    const pluginGeneratedTrackIds = pluginContext.plugin.generatedTrackIdsInternal;
    if (pluginContext.numTracksCreatedByPlugin === pluginGeneratedTrackIds.length) {
      // @ts-ignore
      pluginGeneratedTrackIds.push(Track.generateTrackIdInternal());
    } else if (pluginContext.numTracksCreatedByPlugin > pluginGeneratedTrackIds.length) {
      throw new Error('Plugin generated track ids out of sync.');
    }
    const nextTrackId = pluginGeneratedTrackIds[pluginContext.numTracksCreatedByPlugin];
    pluginContext.numTracksCreatedByPlugin += 1;
    // @ts-ignore
    return nextTrackId;
  }

  private getNextTrackRank() {
    const nextRank = this.nextTrackRank;
    this.nextTrackRank += 1;
    return nextRank;
  }

  private checkAccess(accessName: string) {
    if (!this.pluginContext) {
      throw new Error(
        `Song needs to be accessed in a plugin context in order to use privileged methods.`,
      );
    }
    if (!(this.pluginContext.plugin.songAccess() as any)[accessName]) {
      throw new Error(
        `Plugin ${(
          this.pluginContext.plugin.constructor as any
        ).id()} requires access ${accessName} in order to run.`,
      );
    }
  }

  private static tempoBPMToTicksPerSecond(tempoBPM: number, PPQ: number) {
    return (tempoBPM * PPQ) / 60;
  }

  /**
   * Recalculate all tempo event time.
   */
  private retimingTempoEvents() {
    this.tempos.sort((a, b) => a.getTicks() - b.getTicks());
    // Re-calculate all tempo event time.
    for (const tempoEvent of this.tempos) {
      tempoEvent.setTimeInternal(this.tickToSeconds(tempoEvent.getTicks()));
    }
  }
}

interface PluginContext {
  plugin: TuneflowPlugin;
  numTracksCreatedByPlugin: number;
}

function scaleIntBy(val: number, factor: number) {
  return Math.round(val * factor);
}
