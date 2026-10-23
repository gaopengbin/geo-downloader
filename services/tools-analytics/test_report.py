import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from datetime import datetime, timezone, timedelta
from report import report


class UsageReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.start = datetime(2026, 10, 24, tzinfo=timezone.utc)
        self.until = self.start + timedelta(days=1)
        self.owner, self.test, self.person = ['user-' + str(uuid4()) for _ in range(3)]
        self.accounts = self.root / 'accounts.json'
        self.accounts.write_text(json.dumps({'users': [
            {'id': self.owner, 'email': '1804287165@qq.com'},
            {'id': self.test, 'email': 'test@example.com', 'isTestAccount': True},
            {'id': self.person, 'email': 'person@example.com'}]}))
        (self.root / 'metadata.json').write_text(json.dumps({'schemaVersion': 1, 'startedAt': self.start.isoformat()}))

    def event(self, kind='tool', state='started', **kw):
        return dict(schemaVersion=1, eventId=str(uuid4()), attemptId=str(uuid4()), occurredAt=(self.start+timedelta(hours=1)).isoformat(),
                    userId=self.person, actorType='account', installationId=None, product='mcp', transport='http',
                    kind=kind, state=state, operation='geod_fetch' if kind != 'authorization' else 'login', isTest=False, reason='none', **kw)

    def write(self, events):
        (self.root/'2026-10-24.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in events))

    def read(self):
        return report(self.root, self.accounts, self.start, self.until)

    def test_missing_results_are_unknown_and_final_without_start_is_separate(self):
        start = self.event('download')
        no_start = self.event('download', 'completed')
        partial = self.event('download')
        end = {**partial, 'eventId': str(uuid4()), 'state': 'partial', 'reason': 'incomplete'}
        self.write([start, no_start, partial, end, end])
        result = self.read()
        downloads = result['counts'][0]['downloads']
        self.assertEqual(downloads['startCohortOutcomes'], {'unknown': 1, 'partial': 1})
        self.assertEqual(downloads['terminalWithoutObservedStart'], 1)
        self.assertEqual(result['duplicateEventsIgnored'], 1)

    def test_authorization_refresh_and_tools_are_distinct(self):
        auth = self.event('authorization', 'succeeded')
        refresh = {**auth, 'eventId': str(uuid4()), 'operation': 'refresh'}
        tool = self.event()
        self.write([auth, refresh, tool])
        item = self.read()['counts'][0]
        self.assertEqual(item['authorizations'], 1)
        self.assertEqual(item['tokenRefreshes'], 1)
        self.assertEqual(item['accountsWithToolCalls'], 1)
        self.assertEqual(item['downloads']['observedStarts'], 0)

    def test_owners_internal_tests_and_test_flags_never_count_as_external(self):
        items = [self.event() for _ in range(5)]
        items[0]['userId'] = self.owner
        items[1]['userId'] = self.test
        items[2]['isTest'] = True
        items[3]['actorType'] = 'internal'
        self.write(items)
        result = self.read()
        self.assertEqual(result['excludedEvents'], 4)
        self.assertEqual(result['counts'][0]['tools']['observedStarts'], 1)

    def test_missing_account_store_keeps_identity_unknown(self):
        self.write([self.event()]); self.accounts.unlink()
        result = self.read()
        self.assertEqual(result['accountSourceStatus'], 'unavailable')
        self.assertEqual(result['counts'][0]['population'], 'anonymous_or_unlinked')
        self.assertIsNone(result['counts'][0]['accountsWithToolCalls'])

    def test_uninstrumented_is_not_zero(self):
        (self.root/'metadata.json').unlink()
        result = self.read()
        self.assertEqual(result['status'], 'not_instrumented')
        self.assertIsNone(result['counts'])

    def test_excluded_diagnostics_never_reenter_normal_counts(self):
        event = self.event('download'); event['isTest'] = True
        self.write([event])
        result = report(self.root, self.accounts, self.start, self.until, include_excluded=True)
        self.assertEqual(result['counts'], [])
        self.assertEqual(result['excludedDiagnostics'][0]['downloads']['startCohortOutcomes'], {'unknown': 1})


if __name__ == '__main__':
    unittest.main()
