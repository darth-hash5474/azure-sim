"""Builds src/registry.json from the installed Azure CLI: every command in commands.txt with its
arguments, help text and examples, plus the groups above them. Also writes the CLI's own rendered
--help for each command to test/fixtures/help/, so the TypeScript renderer can be checked against it.

Run through scripts/generate.sh, which uses the Python bundled with the CLI. It reads no account
data, uses a throwaway config folder (so personal `az configure` defaults stay out) and never
installs extensions.
"""
import argparse
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WIDTH = 100  # knack wraps help at a fixed 100 columns, whatever the terminal size

config_dir = tempfile.mkdtemp(prefix='az-registry-')
os.environ['AZURE_CONFIG_DIR'] = config_dir
os.environ.setdefault('AZURE_EXTENSION_DIR', os.path.expanduser('~/.azure/cliextensions'))
os.environ['AZURE_EXTENSION_USE_DYNAMIC_INSTALL'] = 'no'
os.environ['AZURE_CORE_COLLECT_TELEMETRY'] = 'no'
os.environ['AZURE_CORE_NO_COLOR'] = 'true'
os.environ['AZURE_CORE_ONLY_SHOW_ERRORS'] = 'true'

import azure.cli.core.util as az_util  # noqa: E402
from azure.cli.core import __version__ as CLI_VERSION, get_default_cli  # noqa: E402
from azure.cli.core._help import AzCliHelp  # noqa: E402

az_util.show_updates_available = lambda **_: None

captured = {}
_show_help = AzCliHelp.show_help
_print_detailed_help = AzCliHelp._print_detailed_help


def show_help(self, cli_name, nouns, parser, is_group):
    captured['parser'] = parser
    captured['is_group'] = is_group
    return _show_help(self, cli_name, nouns, parser, is_group)


def print_detailed_help(self, cli_name, help_file):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        _print_detailed_help(self, cli_name, help_file)
    captured['text'] = buf.getvalue()
    captured['help_file'] = help_file


AzCliHelp.show_help = show_help
AzCliHelp._print_detailed_help = print_detailed_help


def capture(path):
    captured.clear()
    cli = get_default_cli()
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            cli.invoke(path.split() + ['--help'] if path else ['--help'])
        except SystemExit:
            pass
    if 'help_file' not in captured:
        raise RuntimeError(f"az {path} --help produced no help:\n{sink.getvalue()[-2000:]}")
    return dict(captured)


def status(obj):
    """Preview / deprecated / experimental tag, as the help shows it."""
    for attr, tag in (('deprecate_info', 'Deprecated'), ('preview_info', 'Preview'), ('experimental_info', 'Experimental')):
        info = getattr(obj, attr, None)
        if info:
            # str(message) is what the help prints, "WARNING: ..." prefix included
            return {'tag': tag, 'message': str(info.message) if getattr(info, 'message', None) else None}
    return None


def text(s):
    return (s or '').strip()


def value_kind(action):
    """How the argument takes its value on the command line."""
    if action is None:
        return 'value'
    if action.nargs == 0 or type(action).__name__ in ('_StoreTrueAction', '_StoreFalseAction', '_StoreConstAction', '_CountAction'):
        return 'flag'
    if action.nargs == '?':
        return 'optional'
    if action.nargs in ('+', '*') or (isinstance(action.nargs, int) and action.nargs > 1):
        return 'list'
    return 'value'


def repeats(action):
    """argparse 'append': every use adds to the list instead of the last one winning."""
    return action is not None and type(action).__name__ in ('_AppendAction', '_ExtendAction')


def command_entry(path):
    c = capture(path)
    hf, parser = c['help_file'], c['parser']
    actions = {}
    for a in parser._actions:
        for o in a.option_strings:
            actions[o] = a
    args = []
    for p in hf.parameters:
        names = p.name.split()
        action = next((actions[n] for n in names if n in actions), None)
        sources = []
        for vs in getattr(p, 'value_sources', None) or []:
            if isinstance(vs, dict) and 'string' in vs:
                sources.append({'string': vs['string']})
            elif isinstance(vs, dict) and 'command' in vs.get('link', {}):
                sources.append({'command': vs['link']['command']})
            elif isinstance(vs, dict) and 'url' in vs.get('link', {}):
                sources.append({'url': vs['link']['url']})
            elif not isinstance(vs, dict):
                sources.append({'command': str(vs)})
        args.append({
            'names': names,
            'group': p.group_name or None,
            'required': bool(p.required),
            'kind': value_kind(action),
            'choices': [str(x) for x in p.choices] if p.choices else None,
            # as the help shows it: only a truthy default is printed (False, 0 and [] never are)
            'default': str(p.default) if p.default and p.default != argparse.SUPPRESS and str(p.default) != 'Undefined' else None,
            'defaultSource': getattr(p, 'default_value_source', None) or None,
            'summary': text(p.short_summary),
            'long': text(p.long_summary),
            'valueSources': sources,
            'status': status(p),
        })
    for arg in args:
        action = next((actions[n] for n in arg['names'] if n in actions), None)
        arg['options'] = list(action.option_strings) if action else arg['names']
        arg['repeat'] = repeats(action)
    # Arguments the parser accepts but the help hides (deprecated aliases and the like).
    shown = {o for arg in args for o in arg['options']}
    for a in parser._actions:
        if a.option_strings and not set(a.option_strings) & shown:
            args.append({'names': list(a.option_strings), 'options': list(a.option_strings), 'group': None, 'required': bool(a.required),
                         'kind': value_kind(a), 'choices': [str(x) for x in a.choices] if a.choices else None, 'default': None,
                         'summary': '', 'long': '', 'valueSources': [], 'status': None, 'repeat': repeats(a), 'hidden': True})
    # The parser's own order, which its error messages follow ("the following arguments are required: ...").
    position = {o: i for i, a in enumerate(parser._actions) for o in a.option_strings}
    order = sorted(range(len(args)), key=lambda i: position.get(args[i]['options'][0], len(position) + i))
    # examples are kept byte for byte: a trailing newline in the source prints as a blank line
    examples = [{'summary': getattr(e, 'short_summary', None) or e.name or '', 'long': getattr(e, 'long_summary', None) or '',
                 'command': getattr(e, 'command', None) or e.text or ''} for e in hf.examples]
    return {
        'summary': text(hf.short_summary),
        'long': text(hf.long_summary),
        'status': status(hf),
        'links': [l['url'] for l in (getattr(hf, 'links', None) or []) if l.get('url')],
        'args': args,
        'parserOrder': order,
        'examples': examples,
    }, c['text']


def group_entry(path):
    c = capture(path)
    hf = c['help_file']
    return {'summary': text(hf.short_summary), 'long': text(hf.long_summary), 'status': status(hf)}, c['text']


def main():
    names = []
    with open(os.path.join(HERE, 'commands.txt')) as f:
        for line in f:
            line = line.split('#', 1)[0].strip()
            if line and line not in names:
                names.append(line)

    groups = set()  # the root (`az --help`) is a welcome screen, rendered from the top-level groups
    for n in names:
        parts = n.split()
        for i in range(1, len(parts)):
            groups.add(' '.join(parts[:i]))

    fixtures = os.path.join(ROOT, 'test', 'fixtures', 'help')
    shutil.rmtree(fixtures, ignore_errors=True)
    os.makedirs(fixtures)

    registry = {'cliVersion': CLI_VERSION, 'width': WIDTH, 'groups': {}, 'commands': {}}
    for g in sorted(groups):
        registry['groups'][g], _ = group_entry(g)
        print(f'group   az {g}'.rstrip(), file=sys.stderr)
    for n in names:
        registry['commands'][n], rendered = command_entry(n)
        with open(os.path.join(fixtures, n.replace(' ', '_') + '.txt'), 'w') as f:
            f.write(rendered)
        print(f'command az {n}', file=sys.stderr)

    # Most argument definitions (the global ones above all) repeat across commands: store each once.
    table, index = [], {}
    for entry in registry['commands'].values():
        refs = []
        for arg in entry['args']:
            key = json.dumps(arg, sort_keys=True)
            if key not in index:
                index[key] = len(table)
                table.append(arg)
            refs.append(index[key])
        entry['args'] = refs
    registry['args'] = table

    with open(os.path.join(ROOT, 'src', 'registry.json'), 'w') as f:
        json.dump(registry, f, separators=(',', ':'))
        f.write('\n')
    shutil.rmtree(config_dir, ignore_errors=True)
    print(f"{len(registry['commands'])} commands, {len(registry['groups'])} groups from azure-cli {CLI_VERSION}", file=sys.stderr)


if __name__ == '__main__':
    main()
