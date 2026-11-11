// osu!-editor timestamps: the form a modder pastes into a thread or a chat.
//
// Two shapes, and which one is copied depends on whether anything is picked
// out on the timeline:
//
//   00:12:345                 nothing selected -- just where the playhead is
//   00:12:345 (1,2,3) -       objects selected, named the way the editor
//                             names them, with the dash the comment follows
//
// The objects are whichever the user ringed on the timeline, not whatever
// happens to sit under the playhead: a timestamp says what it is about, and
// only the person writing it knows that. In osu!, taiko and catch they are
// named by combo number; mania uses the "time|column" pairs its own editor
// uses instead.
//
// Pure: no DOM, no state, so the format is testable on a plain object list.

const MANIA_MODE = 3;

const pad = (value, width) => String(value).padStart(width, '0');

/** `mm:ss:mmm` -- the time half of an editor timestamp, and on its own a whole one. */
const formatEditorTime = (timeMs) => {
  const total = Math.max(0, Math.floor(Number(timeMs) || 0));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${pad(minutes, 2)}:${pad(seconds, 2)}:${pad(total % 1000, 3)}`;
};

const formatManiaReference = (objects) => {
  const notes = objects
    .map((object) => ({
      time: Math.max(0, Math.floor(Number(object?.time) || 0)),
      column: Math.max(0, Math.floor(Number(object?.column) || 0)),
    }))
    // Simultaneous notes reach here in whichever order the converter built
    // them; the editor lists a chord left to right.
    .sort((a, b) => (a.time - b.time) || (a.column - b.column));
  return notes.length > 0
    ? `(${notes.map((note) => `${note.time}|${note.column}`).join(',')})`
    : '';
};

const formatComboReference = (objects) => {
  const numbers = objects
    .map((object) => Number(object?.comboNumber))
    .filter((number) => Number.isInteger(number) && number > 0);
  return numbers.length > 0 ? `(${numbers.join(',')})` : '';
};

/**
 * The object list an editor timestamp carries, or '' when the playhead is on
 * nothing -- between two notes, in a break, or past the end of a map the
 * preview had to truncate.
 */
const formatObjectReference = (objects, mode = 0) => {
  const onPlayhead = Array.isArray(objects) ? objects : [];
  if (onPlayhead.length === 0) {
    return '';
  }
  return mode === MANIA_MODE ? formatManiaReference(onPlayhead) : formatComboReference(onPlayhead);
};

/**
 * A whole timestamp, ready to paste.
 *
 * `objects` are the ones selected on the timeline -- the preview's own
 * converted objects, so the combo numbers are the ones on screen rather than
 * the source map's. With none, the bare time is the whole timestamp: there is
 * nothing for a trailing dash to introduce.
 */
const formatEditorTimestamp = (timeMs, { objects = [], mode = 0 } = {}) => {
  const time = formatEditorTime(timeMs);
  const reference = formatObjectReference(objects, mode);
  return reference ? `${time} ${reference} - ` : time;
};

export {
  formatEditorTime,
  formatEditorTimestamp,
  formatObjectReference,
};
