/**
 * The explicit provider manifest — mirrors tasks/index.ts's reasoning exactly. A vendor adapter
 * only does anything (self-registers) if something imports its module; leaving that to chance (a
 * route importing it "because it happens to need it") is the same incidental-import-order risk the
 * task registry already avoids. This file is the one place every known adapter is imported, and
 * src/lib/ai/runAiTask.ts imports THIS module (not any individual adapter) at its own top level, so
 * every adapter that can register (i.e. has its credentials configured) does so before any call to
 * runAiTask can execute — regardless of which route/feature runs first.
 *
 * Adding a second vendor later means adding one import line here — nothing else in the app changes.
 */
import "./openai";
