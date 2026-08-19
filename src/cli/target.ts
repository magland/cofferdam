import { RemoteTarget, remoteTarget } from '../cli-api';
import { CliError, EXIT_AUTH, EXIT_USAGE } from './exit';
import { readStdin } from './input';
import { Invocation, OptionSpec } from './parse';

// Which vault a command talks to, and with what token. Every command that
// reaches a vault takes the same three options, declared once here so that they
// are spelled and documented identically everywhere.

export const TARGET_OPTIONS: OptionSpec[] = [
  {
    name: 'host',
    type: 'string',
    value: '<url>',
    summary: 'Vault URL, ahead of COFFERDAM_HOST and the last login',
  },
  {
    name: 'token',
    type: 'string',
    value: '<t>',
    summary: "Token, ahead of COFFERDAM_TOKEN and git's credential store",
  },
  {
    name: 'token-stdin',
    type: 'boolean',
    summary: 'Read the token from stdin, so it is in neither argv nor shell history',
  },
];

/** The vault and token a command should use, from its options, the environment, or the login. */
export async function targetFrom(inv: Invocation): Promise<RemoteTarget> {
  let token = inv.str('token');
  if (inv.bool('token-stdin')) {
    // Two ways of saying where the token comes from is a usage error, as every
    // other "not both" in the CLI is; an empty stdin below is not, because
    // there the invocation was fine and the token is what is missing.
    if (token) throw new CliError('Pass either --token or --token-stdin, not both.', EXIT_USAGE);
    token = (await readStdin()).trim();
    if (!token) throw new CliError('--token-stdin was given but stdin was empty.', EXIT_AUTH);
  }
  return await remoteTarget({ host: inv.str('host'), token });
}
