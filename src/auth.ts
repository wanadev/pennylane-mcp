export function resolveApiKey(cliFlag?: string): string {
  const fromEnv = process.env.PENNYLANE_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const fromFlag = cliFlag?.trim();
  if (fromFlag) return fromFlag;

  throw new Error(
    'Pennylane API key is required. Set PENNYLANE_API_KEY in the environment, ' +
      'or pass --apiKey <key> on the command line. ' +
      'See https://pennylane.readme.io/docs/generating-my-api-token',
  );
}
