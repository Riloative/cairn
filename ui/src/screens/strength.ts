import { useEffect, useState } from "react";

export interface StrengthResult {
  /** 0 (weak) … 4 (strong), as defined by zxcvbn. */
  score: 0 | 1 | 2 | 3 | 4;
  warning: string;
  suggestions: string[];
  crackTime: string;
}

type Estimator = (password: string) => StrengthResult;

let estimatorPromise: Promise<Estimator> | null = null;

/** Lazily load zxcvbn-ts with its dictionaries (only the setup screens need them). */
export function loadEstimator(): Promise<Estimator> {
  estimatorPromise ??= Promise.all([
    import("@zxcvbn-ts/core"),
    import("@zxcvbn-ts/language-common"),
    import("@zxcvbn-ts/language-en"),
  ]).then(([core, common, en]) => {
    const factory = new core.ZxcvbnFactory({
      translations: en.translations,
      graphs: common.adjacencyGraphs,
      dictionary: { ...common.dictionary, ...en.dictionary },
    });
    return (password: string) => {
      const r = factory.check(password, ["cairn"]);
      return {
        score: r.score,
        warning: r.feedback.warning ?? "",
        suggestions: r.feedback.suggestions,
        crackTime: String(r.crackTimes.offlineSlowHashingXPerSecond.display),
      };
    };
  });
  return estimatorPromise;
}

export function useStrength(password: string): StrengthResult | null {
  const [estimate, setEstimate] = useState<Estimator | null>(null);
  useEffect(() => {
    let alive = true;
    void loadEstimator().then((fn) => alive && setEstimate(() => fn));
    return () => {
      alive = false;
    };
  }, []);
  return estimate && password ? estimate(password) : null;
}
