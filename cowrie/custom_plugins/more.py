from __future__ import annotations

from cowrie.commands.cat import Command_cat

commands = {}


class Command_more(Command_cat):
    """Simple pager-compatible alias that behaves like cat."""


commands["/bin/more"] = Command_more
commands["more"] = Command_more
