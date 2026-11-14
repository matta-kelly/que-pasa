/** A run's questions as a client gets them, from every surface: the deployment shows each one not answered yet. */
import type { Interrupt } from "../define/index.ts";
import type { RunInfo } from "../loop/index.ts";

/** A run with its unanswered questions as a client gets them. */
export async function shownInfo(
  info: RunInfo,
  show: (interrupt: Interrupt) => Promise<Interrupt>,
): Promise<RunInfo> {
  const questions = [];
  for (const question of info.questions)
    questions.push(
      question.answer === undefined
        ? { ...question, ...(await show(question)) }
        : question,
    );
  return { ...info, questions };
}
