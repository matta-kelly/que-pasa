import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { RunOutcome } from "./runtime.ts";

/** A scripted model for tests: each test queues the replies it gives, in order. */
export function scripted() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { faux, models, model: `${model.provider}:${model.id}` };
}

/** A run's result, when it is done: a test that expects no question fails on one. */
export function resultOf<R>(outcome: RunOutcome<R>): R {
  if (outcome.status !== "done") {
    throw new Error(`the run waits on ${JSON.stringify(outcome.interrupts)}`);
  }
  return outcome.result;
}
