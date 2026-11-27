#!/usr/bin/env python3
"""공개 문항 JEV 실험. uv run --with numpy --with scikit-learn python ..."""
import argparse
import hashlib
import json
import platform
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss


def groups_for(records):
    parents = list(range(len(records)))

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    seen = {}
    for i, r in enumerate(records):
        keys = [('law', g['lawId']) for g in r['gt']]
        keys.append(('query', ''.join(r['q'].lower().split())))
        for key in keys:
            if key in seen:
                parents[root(i)] = root(seen[key])
            seen[key] = i
    return np.array([root(i) for i in range(len(records))])


def folds_for(indices, groups, n=5):
    buckets = defaultdict(list)
    for i in indices:
        buckets[int(groups[i])].append(int(i))
    folds = [[] for _ in range(min(n, len(buckets)))]
    if len(folds) < 2:
        raise ValueError('NEED_AT_LEAST_TWO_GROUPS')
    for _, items in sorted(buckets.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        fold = min(range(len(folds)), key=lambda j: (len(folds[j]), j))
        folds[fold].extend(items)
    return [sorted(f) for f in folds]


def fit_article(records, indices, C=1.0):
    candidates = [c for i in indices for c in records[i]['candidates']]
    y = np.array([c['label'] for c in candidates])
    if len(np.unique(y)) < 2:
        raise ValueError('TRAINING_REQUIRES_BOTH_CLASSES')
    model = make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=2000, random_state=0))
    model.fit(np.array([c['features'] for c in candidates]), y)
    return model


def predict(model, record):
    return model.predict_proba(np.array([c['features'] for c in record['candidates']]))[:, 1] if record['candidates'] else np.array([])


def rule_rows(record, scores, positive_only=False):
    rules = defaultdict(list)
    for c, score in zip(record['candidates'], scores, strict=True):
        if not positive_only or score > 0:
            rules[c['lawId']].append((float(score), c))
    rows = []
    for law, articles in rules.items():
        articles.sort(key=lambda x: (-x[0], x[1]['id']))
        rows.append({'lawId': law, 'score': articles[0][0], 'articles': articles[:3]})
    return sorted(rows, key=lambda r: (-r['score'], r['lawId']))


def fit_rule(records, indices, groups):
    # Rule calibration sees only inner out-of-fold article probabilities.
    X, y = [], []
    for validation in folds_for(indices, groups, n=3):
        train = sorted(set(indices) - set(validation))
        model = fit_article(records, train)
        for i in validation:
            truth = {g['lawId'] for g in records[i]['gt']}
            for row in rule_rows(records[i], predict(model, records[i])):
                X.append([row['score']])
                y.append(int(row['lawId'] in truth))
    model = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=2000, random_state=0))
    model.fit(X, y)
    if model[-1].coef_[0, 0] < 0:
        raise ValueError('RULE_CALIBRATION_NOT_MONOTONIC')
    return model


def model_json(model):
    return {'mean': model[0].mean_.tolist(), 'scale': model[0].scale_.tolist(),
            'weights': model[-1].coef_[0].tolist(), 'intercept': float(model[-1].intercept_[0])}


def evaluate_record(record, scores, rule_model=None, positive_only=False):
    start = time.perf_counter()
    rows = rule_rows(record, scores, positive_only)
    truth = {g['lawId'] for g in record['gt']}
    ranked = sorted(zip(scores, record['candidates'], strict=True), key=lambda x: (-x[0], x[1]['id']))
    if positive_only:
        ranked = [x for x in ranked if x[0] > 0]
    rule_labels = [int(r['lawId'] in truth) for r in rows]
    rule_probs = rule_model.predict_proba([[r['score']] for r in rows])[:, 1].tolist() if rule_model is not None and rows else []
    return {'id': record['id'], 'top1': bool(rows and rows[0]['lawId'] in truth),
            'top3': any(r['lawId'] in truth for r in rows[:3]),
            'articleTop3': any(c['label'] for _, c in ranked[:3]),
            'selectedArticleHit': any(c['label'] for r in rows[:3] for _, c in r['articles']),
            'candidateHit': any(c['label'] for _, c in ranked),
            'topRules': [{'lawId': r['lawId'], 'score': r['score'],
                          'probability': rule_probs[j] if rule_probs else None,
                          'articles': [{'article': c['article'], 'label': c['label'], 'score': p} for p, c in r['articles']]}
                         for j, r in enumerate(rows[:3])],
            'ruleLabels': rule_labels, 'ruleProbabilities': rule_probs,
            'ruleScores': [{'lawId': r['lawId'], 'probability': rule_probs[j]} for j, r in enumerate(rows)] if rule_probs else [],
            'selectionMs': (time.perf_counter() - start) * 1000}


def calibration(y, p):
    if not y:
        return None
    y, p = np.array(y), np.array(p)
    ece = 0.0
    for low in np.arange(0, 1, .1):
        mask = (p >= low) & (p < low + .1 if low < .9 else p <= 1)
        if mask.any():
            ece += float(mask.mean() * abs(y[mask].mean() - p[mask].mean()))
    return {'n': len(y), 'positives': int(y.sum()), 'brier': float(brier_score_loss(y, p)),
            'logLoss': float(log_loss(y, p, labels=[0, 1])), 'ece10': ece,
            'positiveRate': float(y.mean()), 'meanProbability': float(p.mean())}


def summary(rows):
    keys = ['top1', 'top3', 'articleTop3', 'selectedArticleHit', 'candidateHit']
    return {k: {'hits': sum(r[k] for r in rows), 'total': len(rows), 'rate': sum(r[k] for r in rows) / len(rows)} for k in keys}


def percentiles(values):
    return {'p50': float(np.median(values)), 'p95': float(np.percentile(values, 95))}


def comparison_by_id(before, after, metrics):
    before_by_id = {r['id']: r for r in before}
    if len(before_by_id) != len(before) or len({r['id'] for r in after}) != len(after) or set(before_by_id) != {r['id'] for r in after}:
        raise ValueError('COMPARISON_QUESTION_SET_MISMATCH')
    return {key: {'newWrong': [r['id'] for r in after if before_by_id[r['id']][key] and not r[key]],
                  'fixed': [r['id'] for r in after if not before_by_id[r['id']][key] and r[key]]} for key in metrics}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--reference', help='t10x final-v3 production MCP baseline, same corpus and public fixtures')
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise ValueError('OUTPUT_EXISTS')
    raw = Path(args.evidence).read_bytes()
    evidence = json.loads(raw)
    records = evidence['records']
    if len(records) != 71 or {s['count'] for s in evidence['sources']} != {46, 25}:
        raise ValueError('PUBLIC_FIXTURE_COUNT_MISMATCH')
    reference = None
    if args.reference:
        ref_raw = Path(args.reference).read_bytes()
        ref = json.loads(ref_raw)
        if ref['after']['indexSha256'] != evidence['corpusHash'] or {s['sha256'] for s in ref['questionFiles']} != {s['sha256'] for s in evidence['sources']}:
            raise ValueError('REFERENCE_SNAPSHOT_MISMATCH')
        if ref['after']['sourceHashes']['corpus.js'] != evidence['codeHashes']['src/corpus.js']:
            raise ValueError('REFERENCE_PRODUCTION_SCORER_MISMATCH')
        reference = {'path': args.reference, 'sha256': hashlib.sha256(ref_raw).hexdigest(),
                     'scope': 't10x full MCP baseline; JEV below is isolated retrieval, not a full MCP replacement run',
                     'summary': ref['after']['summary'], 'results': ref['after']['results']}
    groups = groups_for(records)
    folds = folds_for(range(len(records)), groups)
    predictions, fold_reports = {}, []
    article_y, article_p, rule_y, rule_p = [], [], [], []
    returned_article_y, returned_article_p, returned_rule_y, returned_rule_p = [], [], [], []
    inference_ms = []
    for fold_id, validation in enumerate(folds):
        train = sorted(set(range(len(records))) - set(validation))
        train_laws = {g['lawId'] for i in train for g in records[i]['gt']}
        test_laws = {g['lawId'] for i in validation for g in records[i]['gt']}
        assert not train_laws & test_laws
        model = fit_article(records, train)
        rule_model = fit_rule(records, train, groups)
        training = [evaluate_record(records[i], predict(model, records[i])) for i in train]
        fold_rows = []
        for i in validation:
            t = time.perf_counter()
            scores = predict(model, records[i])
            pred = evaluate_record(records[i], scores, rule_model)
            inference_ms.append((time.perf_counter() - t) * 1000)
            predictions[i] = pred
            fold_rows.append(pred)
            article_y.extend(c['label'] for c in records[i]['candidates'])
            article_p.extend(scores.tolist())
            rule_y.extend(pred['ruleLabels'])
            rule_p.extend(pred['ruleProbabilities'])
            returned_rule_y.extend(pred['ruleLabels'][:3])
            returned_rule_p.extend(pred['ruleProbabilities'][:3])
            for rule in pred['topRules']:
                returned_article_y.extend(c['label'] for c in rule['articles'])
                returned_article_p.extend(c['score'] for c in rule['articles'])
        fold_reports.append({'fold': fold_id, 'trainCount': len(train), 'validationCount': len(validation),
                             'validationGroups': len(set(groups[validation])),
                             'validationIds': [records[i]['id'] for i in validation],
                             'train': summary(training), 'validation': summary(fold_rows)})
    assert set(predictions) == set(range(len(records)))
    jev = [predictions[i] for i in range(len(records))]
    baseline = {field: [evaluate_record(r, [c[field] for c in r['candidates']], positive_only=True) for r in records]
                for field in ['rrf', 'expandedRrf']}
    train = [i for i, r in enumerate(records) if r['split'] == 'train']
    dev = [i for i, r in enumerate(records) if r['split'] == 'dev']
    train_model = fit_article(records, train)
    dev_rows = [evaluate_record(records[i], predict(train_model, records[i])) for i in dev]
    dev_model = fit_article(records, dev)
    reverse_rows = [evaluate_record(records[i], predict(dev_model, records[i])) for i in train]
    # Predeclared neighbors, reported without selecting the best setting.
    sensitivity = {}
    for C in [0.5, 1.0, 2.0]:
        rows = []
        for validation in folds:
            fit = fit_article(records, sorted(set(range(len(records))) - set(validation)), C=C)
            rows.extend(evaluate_record(records[i], predict(fit, records[i])) for i in validation)
        sensitivity[str(C)] = {'summary': summary(rows), 'vsDefault': comparison_by_id(jev, rows, ['top1', 'top3', 'articleTop3', 'selectedArticleHit'])}
    all_model = fit_article(records, list(range(len(records))))
    all_rule_model = fit_rule(records, list(range(len(records))), groups)
    # Cluster bootstrap preserves dependence between questions about one rule.
    rng = np.random.default_rng(20261127)
    group_ids = np.unique(groups)
    diffs = np.array([int(a['selectedArticleHit']) - int(b['selectedArticleHit']) for a, b in zip(jev, baseline['rrf'], strict=True)])
    boots = []
    for _ in range(2000):
        sampled = np.concatenate([np.where(groups == g)[0] for g in rng.choice(group_ids, len(group_ids), replace=True)])
        boots.append(float(diffs[sampled].mean()))
    metadata = {k: v for k, v in evidence.items() if k != 'records'}
    report = {'metadata': metadata, 'evidenceSha256': hashlib.sha256(raw).hexdigest(),
              'evaluatorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'python': platform.python_version(), 'numpy': np.__version__, 'sklearn': sklearn.__version__,
              'groups': len(group_ids), 'folds': fold_reports,
              'summary': {'rrf': summary(baseline['rrf']), 'expandedRrf': summary(baseline['expandedRrf']), 'jevOOF': summary(jev),
                          'train46ToDev25': summary(dev_rows),
                          'dev25ToTrain46': summary(reverse_rows),
                          'rrfDev25': summary([baseline['rrf'][i] for i in dev])},
              'pairedSelectedHitDelta': {'mean': float(diffs.mean()), 'clusterBootstrap95': np.percentile(boots, [2.5, 97.5]).tolist(),
                                         'wins': int((diffs > 0).sum()), 'losses': int((diffs < 0).sum())},
              'calibrationOOF': {'article': calibration(article_y, article_p), 'rule': calibration(rule_y, rule_p),
                                 'returnedArticles': calibration(returned_article_y, returned_article_p),
                                 'returnedRules': calibration(returned_rule_y, returned_rule_p)},
              'latencyMs': {'rrfGather': percentiles([r['rrfMs'] for r in records]),
                            'jevGather': percentiles([r['jevMs'] for r in records]),
                            'featureConstruction': percentiles([r['featureMs'] for r in records]),
                            'pythonPredictionAndSelection': percentiles(inference_ms)},
              'records': [{'id': r['id'], 'group': int(groups[i]), 'rrf': baseline['rrf'][i], 'expandedRrf': baseline['expandedRrf'][i], 'jevOOF': jev[i]} for i, r in enumerate(records)],
              'sensitivityC': sensitivity,
              'newWrongVsRrf': comparison_by_id(baseline['rrf'], jev, ['top1', 'top3', 'articleTop3', 'selectedArticleHit']),
              'model': {'version': 1, 'fingerprint': evidence['fingerprint'], 'featureNames': evidence['featureNames'],
                        'article': model_json(all_model), 'rule': model_json(all_rule_model),
                        'scope': 'Experimental; fitted on all 71 public questions, not independently evaluated. No production activation.'}}
    if records and all('production' in r for r in records):
        report['productionSearchCorpus'] = {}
        for mode in ['off', 'on']:
            rows = [{'id': r['id'], **r['production'][mode]} for r in records]
            report['productionSearchCorpus'][mode] = {
                'scope': 'Unchanged production searchCorpus only; top3 rules with 3 selected blocks; no index.js final ranking/excerpt pipeline',
                'top3': {'hits': sum(r['top3'] for r in rows), 'total': len(rows)},
                'selectedArticleHit': {'hits': sum(r['selectedArticleHit'] for r in rows), 'total': len(rows)},
                'latencyMs': percentiles([r['elapsedMs'] for r in rows]),
                'jevVsProduction': comparison_by_id(rows, jev, ['top3', 'selectedArticleHit']), 'records': rows}
    if reference:
        report['productionMcpReference'] = {k: v for k, v in reference.items() if k != 'results'}
        report['productionMcpReference']['ruleTop3Diagnostic'] = comparison_by_id(reference['results'], jev, ['top3'])
        ref_selection = [{'id': r['id'], 'selectedArticleHit': r['strict']} for r in reference['results']]
        report['productionMcpReference']['crossScopeSelectedDiagnostic'] = comparison_by_id(ref_selection, jev, ['selectedArticleHit'])
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: report[k] for k in ['groups', 'summary', 'pairedSelectedHitDelta', 'calibrationOOF', 'latencyMs']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
