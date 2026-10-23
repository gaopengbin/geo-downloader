"""Read-only GeoD CLI/MCP observations. No prompt or raw identity is exported."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path

OWNERS = {'1804287165@qq.com', 'pengbingao@gmail.com'}
BJ = timezone(timedelta(hours=8))


def timestamp(value):
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('timezone required')
    return dt


def report(directory, accounts, start, until, include_excluded=False):
    directory = Path(directory)
    result = {'windowStart': start.isoformat(), 'windowEnd': until.isoformat(),
              'status': 'not_instrumented', 'counts': None,
              'notes': ['Only observed events are counted; absent results remain unknown.',
                        'Local reporting is opt-in. Anonymous installations are not people or verified external accounts.',
                        'OAuth refreshes are separate from authorization, and protocol handshakes are not tools.',
                        'Packages downloaded and historical OAuth state are not backfilled as tool usage.']}
    try:
        metadata = json.loads((directory / 'metadata.json').read_text(encoding='utf-8'))
        declared = timestamp(metadata['startedAt'])
        if metadata.get('schemaVersion') != 1 or declared >= until:
            return result
    except (OSError, ValueError, KeyError):
        return result
    try:
        users = json.loads(Path(accounts).read_text(encoding='utf-8'))['users']
        by_id = {u['id']: u for u in users}
        excluded = {u['id'] for u in users if u.get('email', '').lower() in OWNERS or
                    u.get('analyticsAudience') == 'internal' or u.get('isTestAccount') is True}
        account_status = 'available'
    except (OSError, ValueError, KeyError, TypeError):
        by_id, excluded, account_status = {}, set(), 'unavailable'
    records, seen, malformed, duplicates = [], set(), 0, 0
    for file in sorted(directory.glob('????-??-??.jsonl')):
        with file.open(encoding='utf-8') as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                    if event['schemaVersion'] != 1 or event['kind'] not in ('authorization', 'tool', 'download'):
                        raise ValueError('invalid event')
                    at = timestamp(event['occurredAt'])
                    if at >= until:
                        continue
                    key = (event.get('actorType'), event.get('userId') or event.get('installationId'), event['eventId'])
                    if key in seen:
                        duplicates += 1
                        continue
                    seen.add(key)
                    records.append(event)
                except (ValueError, KeyError, TypeError):
                    malformed += 1
    # A known owner/test installation is conservatively excluded even if it was
    # anonymous in another observation. Unknown anonymous IDs remain separate.
    excluded_installations = {e.get('installationId') for e in records if e.get('installationId') and
                              (e.get('userId') in excluded or e.get('actorType') == 'internal')}
    def segment(e):
        if e.get('isTest') or e.get('userId') in excluded or e.get('actorType') == 'internal' or e.get('installationId') in excluded_installations:
            return 'excluded'
        if e.get('userId') in by_id:
            return 'non_owner_non_test_accounts'
        return 'anonymous_or_unlinked'
    grouped = defaultdict(list)
    excluded_count = 0
    for e in records:
        group = segment(e)
        if group == 'excluded':
            if start <= timestamp(e['occurredAt']) < until:
                excluded_count += 1
            if not include_excluded:
                continue
        grouped[(e['product'], e['transport'], group)].append(e)
    summaries = []
    for (product, transport, group), events in sorted(grouped.items()):
        observed = [e for e in events if start <= timestamp(e['occurredAt']) < until]
        if not observed:
            continue
        def outcome(kind):
            starts, ends = {}, {}
            for e in sorted(events, key=lambda e: timestamp(e['occurredAt'])):
                if e['kind'] != kind:
                    continue
                identity = e.get('userId') or e.get('installationId') or 'unlinked'
                key = (identity, e['attemptId'])
                if e['state'] == 'started':
                    starts.setdefault(key, e)
                else:
                    ends[key] = e
            cohort = {key: e for key, e in starts.items() if start <= timestamp(e['occurredAt']) < until}
            states = Counter(ends[key]['state'] if key in ends else 'unknown' for key in cohort)
            finals = [e for e in ends.values() if start <= timestamp(e['occurredAt']) < until]
            return {'observedStarts': len(cohort), 'startCohortOutcomes': dict(states),
                    'observedTerminalOutcomes': dict(Counter(e['state'] for e in finals)),
                    'terminalWithoutObservedStart': sum(key not in starts for key, e in ends.items() if start <= timestamp(e['occurredAt']) < until),
                    'failureReasons': dict(Counter(e['reason'] for e in finals if e['state'] in ('failed', 'interrupted')))}
        auths = [e for e in observed if e['kind'] == 'authorization' and e['operation'] == 'login']
        tool_events = [e for e in observed if e['kind'] == 'tool']
        summaries.append({'product': product, 'transport': transport, 'population': group,
                          'authorizedAccounts': len({e['userId'] for e in auths if e.get('userId') in by_id}) if group == 'non_owner_non_test_accounts' else None,
                          'authorizations': len(auths),
                          'tokenRefreshes': sum(e['kind'] == 'authorization' and e['operation'] == 'refresh' for e in observed),
                          'accountsWithToolCalls': len({e['userId'] for e in tool_events if e.get('userId') in by_id}) if group == 'non_owner_non_test_accounts' else None,
                          'observedInstallationIds': len({e['installationId'] for e in observed if e.get('installationId')}),
                          'tools': outcome('tool'), 'downloads': outcome('download'),
                          'toolOperations': dict(Counter(e['operation'] for e in tool_events if e['state'] == 'started')),
                          'latestObserved': max(e['occurredAt'] for e in observed)})
    result.update(status='recording', startedAt=declared.isoformat(), accountSourceStatus=account_status,
                  counts=[s for s in summaries if s['population'] != 'excluded'], excludedEvents=excluded_count, duplicateEventsIgnored=duplicates,
                  unreadableEvents=malformed, completeCoverage=False)
    if include_excluded:
        result['excludedDiagnostics'] = [s for s in summaries if s['population'] == 'excluded']
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', default='/srv/laogao/data/geod-mcp/usage')
    parser.add_argument('--accounts', default='/srv/laogao/data/geod-studio/accounts/store.json')
    parser.add_argument('--start')
    parser.add_argument('--until')
    parser.add_argument('--days', type=int, default=7)
    parser.add_argument('--include-excluded', action='store_true', help='Separate diagnostics only; never included in usage counts')
    args = parser.parse_args()
    until = timestamp(args.until) if args.until else datetime.now(BJ)
    start = timestamp(args.start) if args.start else until - timedelta(days=args.days)
    print(json.dumps(report(args.directory, args.accounts, start, until, args.include_excluded), ensure_ascii=False, indent=2))
