# UI Design Guidelines for Agents

> **Source:** Distilled from Joel Spolsky's [*Designing for People Who Have Better Things To Do With Their Lives*](https://www.joelonsoftware.com/2000/04/26/designing-for-people-who-have-better-things-to-do-with-their-lives/) (April 26, 2000).

## Core Mindset

Assume every user is giving your UI **only ~30% of their attention**. They are not stupid—they are busy, distracted, possibly using a second language, and focused on their own goal rather than learning your interface.

Design around two working assumptions:
1. **Users do not have the manual—and if they did, they wouldn't read it.**
2. **Users do not read text on the screen—and the more words you add, the fewer people will read them.**

Making a UI effortless for distracted beginners also makes it faster and nicer for power users (like grab bars in a bathtub—designed for accessibility, appreciated by everyone).

---

## What to DO

### 1. Make the UI Self-Evident Without Documentation
- **DO** design flows so a user who knows the domain can complete tasks without reading a manual, onboarding tour, or help page.
- **DO** rely on clear visual hierarchy, familiar controls, and obvious labels rather than prose explanations.
- **DO** provide safe, sensible defaults so users who skip instructions and click straight through still succeed.
- **DO** place any necessary reference/help information behind just-in-time triggers (e.g., optional tooltips or help links) for users who actively seek it.

### 2. Keep UI Copy Ruthlessly Short and Simple
- **DO** minimize word counts on dialogs, labels, buttons, empty states, and error messages—fewer words dramatically increase the chance the text is actually read.
- **DO** use plain, everyday language at a simple reading level.
- **DO** aim for 2–5 words in dialog prompts and action labels whenever possible.
- **DO** make button labels state the exact action (e.g., `Exit`, `Delete`, `Save`) so users don't have to parse a paragraph to know what clicking will do.

### 3. Execute Safe Actions Immediately
- **DO** perform safe, non-destructive, or easily reversible actions immediately without asking for confirmation.
- **DO** reserve confirmation dialogs strictly for genuinely destructive or irreversible actions (e.g., permanent deletion, discarding unsaved work).

### 4. Optimize for "Easy to Use", Not Merely "Possible to Use"
- **DO** remove friction even when users could eventually figure it out—small confusions compound into task failure under distraction.
- **DO** design for distracted, non-technical, and non-native-speaking users first; power users benefit from the resulting clarity and speed.

---

## What NOT to Do

### 1. Don't Write Paragraphs or "Faculty Memos" in the UI
- **DON'T** try to compensate for the lack of a manual by stuffing lengthy instructions into dialogs, banners, or forms.
  - Power users skip long text.
  - Most novices skip long text and hope defaults work.
  - Novices who do try to read long text often get *more* confused by the extra words and concepts.
- **DON'T** use complex sentences, jargon, or parenthetical clauses in UI copy.
- **DON'T** add filler politeness words like `"Please"` or `"Thank you for using..."` in dialogs—they add visual bulk and measurably reduce the number of users who read the message.

### 2. Don't Prompt for Unnecessary Confirmations
- **DON'T** ask `"Are you sure?"` for harmless actions like closing/exiting an app with nothing unsaved, navigating away safely, or toggling reversible settings.
- **DON'T** use phrasing that makes users second-guess themselves. Many users assume that if the computer questions their choice, they must have made a mistake—causing them to click `"No"` even when they meant to proceed.

### 3. Don't Assume Users Read Error Boxes
- **DON'T** expect users to read a multi-sentence error dialog and follow manual recovery steps.
- **DON'T** treat an error modal as a conversation where the user carefully reads every word—prevent the error through good UI constraints/defaults first, and when an error is unavoidable, state the issue and action in the fewest possible words.

---

## Quick Examples

| Scenario | DON'T | DO |
| --- | --- | --- |
| Exiting an app with no unsaved changes | Show a modal: *"Thank you for using App. Are you sure you want to exit?"* | Exit immediately with no dialog. |
| Confirmation when genuinely required | *"Thank you for using Juno. Are you sure you want to exit? (Any unsaved session state will be closed.)"* `[Yes]` `[No]` | *"Exit Juno?"* `[Exit]` `[Cancel]` |
| Dialog / form instructions | 60–80 words explaining every option, edge case, and polite preamble (*"Please select the option below that best matches..."*). | 3–5 words + smart default pre-selected. |
| Error message | *"We're sorry, please note that the file you selected cannot be opened because this application does not currently support that file format."* | *"Unsupported file format."* + clear next step. |

---

## Agent Pre-Ship UI Checklist

Before finalizing any generated UI, verify:
- [ ] **No manual required:** Can a distracted first-time user complete the primary task without reading external docs?
- [ ] **Word count cut to the bone:** Can every dialog, tooltip, and helper text be shortened by 50% without losing meaning?
- [ ] **No filler or parentheticals:** Removed unnecessary `"please"`, `"thank you"`, and side-notes from prompts and modals?
- [ ] **No gratuitous confirmations:** Removed `"Are you sure?"` dialogs on safe or reversible actions?
- [ ] **Sensible defaults:** If a user ignores all copy and clicks the primary action, does the right thing happen?
