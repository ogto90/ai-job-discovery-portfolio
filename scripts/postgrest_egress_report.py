#!/usr/bin/env python3
"""Aggregate content-free app/discovery logs: python scripts/postgrest_egress_report.py LOG..."""
import argparse
from collections import defaultdict
import json


def aggregate(lines):
    totals = defaultdict(lambda: {'requests': 0, 'response_body_bytes': 0, 'errors': 0})
    for line in lines:
        try:
            row = json.loads(line[line.index('{'):])
        except (ValueError, TypeError):
            continue
        if row.get('event') != 'postgrest_response':
            continue
        key = (row['runtime'], row['endpoint'], row['method'])
        totals[key]['requests'] += 1
        totals[key]['response_body_bytes'] += int(row['response_body_bytes'])
        totals[key]['errors'] += int(row['status'] == 0 or row['status'] >= 400)
    return [{'runtime': key[0], 'endpoint': key[1], 'method': key[2], **value}
            for key, value in sorted(totals.items(), key=lambda item: item[1]['response_body_bytes'], reverse=True)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('logs', nargs='+')
    args = parser.parse_args()
    def lines():
        for path in args.logs:
            with open(path) as stream:
                yield from stream
    print(json.dumps({'measurement': 'response body bytes; not billed egress', 'endpoints': aggregate(lines())}, indent=2))


if __name__ == '__main__':
    main()
