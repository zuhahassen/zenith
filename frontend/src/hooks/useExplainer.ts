import { useMutation } from "@tanstack/react-query";
import axios from "axios";
import type { ChatMessage, ExplainResponse } from "../types/zenith";

interface AskArgs {
  question: string;
  plan_context: Record<string, unknown>;
  history: ChatMessage[];
}

export function useExplainer() {
  return useMutation<ExplainResponse, Error, AskArgs>({
    mutationFn: async ({ question, plan_context, history }) => {
      const { data } = await axios.post<ExplainResponse>(
        "/api/explain",
        { question, plan_context, history },
        { timeout: 30_000 },
      );
      return data;
    },
  });
}
