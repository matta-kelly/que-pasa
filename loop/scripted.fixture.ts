import { createModels, fauxProvider } from "@earendil-works/pi-ai";

/** A scripted model for tests: each test queues the replies it gives, in order. */
export function scripted() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { faux, models, model: `${model.provider}:${model.id}` };
}
