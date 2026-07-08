
This project develops a container-based agent platform.
It consists of 2 parts: Part 1 is a command-and-control server with a web UI.
Part 2 are container-based agents that are started by the C2C server.

Agents are short-lived, container-based instances running the opencode coding agent.
They are, however, not typically used for coding, but rather, to solve a domain-specific
task for which they may use coding, write programs, run them, and analyze the results.
They are fired up for one task whose results (output and files, if any), are harvested
after completion.  They are started in a sandboxed environment where the opencode
coding agent has access to standard tools (for instance, Python, and other programming
languages), plus a list of configured MCP servers.   See opencode-master-config/
for an example of an opencode.jsonc configuration with 2 MCP servers, a default
system prompt ("majel"), a default model, and api keys to one or more OpenAI-compatible
models. Opencode can be started in a server mode, see `opencode-docs.json` for the API.
More info on how opencode can be configured is in `opencode-config-help.html`
Agents may be provided with one or more files as well when started.
Agents should be able to start from a single container image `SANDBOX_CONTAINER_IMAGE`.

The C2C server keeps track of which agents are running, which have completed, and
what the results were.  It uses K8s to start these agents.  The k8s configuration is in 
endeavour.yaml (which is a secret file).

The C2C frontend server uses CAS for authentication. (See .env for information,
make a .env.sample and keep the secrets out of git).  It will have 2 roles:
admin - full access as well as regular users.  Regular users must be explicitly
added by the admin.

Use a postgres database in a separate sidekick container to store all data.

For the C2C server let's use use React Router v7 and TypeScript.
Let's use Material UI for the user interface.  Include a sun/moon theme switch.
The app needs to be responsive.

Admin users need to be able to configure agents: the MCP servers they have access to,
etc.

Regular users need to be able to choose from configured agents, submit a task ("prompt")
to them and then monitor their status and, finally, their results.

Design the C2C framework to be extensible such that agents can, in the future, by
triggered by external events.

