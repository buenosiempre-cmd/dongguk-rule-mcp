import importlib.util
from pathlib import Path
import unittest
import copy
import numpy as np

spec = importlib.util.spec_from_file_location('jev_eval', Path(__file__).parents[1] / 'scripts/evaluate-jev.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class EvaluationTests(unittest.TestCase):
    def test_alternative_laws_and_duplicate_queries_stay_together(self):
        records = [{'q': q, 'gt': [{'lawId': x} for x in laws]} for q, laws in
                   [('a',[1]), ('b',[1,2]), ('c',[2]), (' same query ',[3]), ('samequery',[4]), ('other',[5])]]
        groups = m.groups_for(records)
        self.assertEqual(len(set(groups)), 3)
        folds = m.folds_for(range(6), groups)
        self.assertEqual(sorted(i for f in folds for i in f), list(range(6)))
        for fold in folds:
            other = set(range(6)) - set(fold)
            self.assertFalse(set(groups[fold]) & set(groups[list(other)]))
        with self.assertRaisesRegex(ValueError, 'TWO_GROUPS'):
            m.folds_for([0,1,2], groups)

    def test_no_top4_or_other_rule_article_credit(self):
        record = {'id':'x','gt':[{'lawId':4}], 'candidates':[
            {'id':i,'lawId':i+1,'article':'제1조','label':int(i==3)} for i in range(4)]}
        result = m.evaluate_record(record, np.array([.9,.8,.7,.6]))
        self.assertTrue(result['candidateHit'])
        self.assertFalse(result['top3'])
        self.assertFalse(result['selectedArticleHit'])
        self.assertFalse(result['articleTop3'])
        empty = m.evaluate_record(record, np.zeros(4), positive_only=True)
        self.assertFalse(empty['candidateHit'])

    def test_single_class_rejected(self):
        with self.assertRaisesRegex(ValueError, 'BOTH_CLASSES'):
            m.fit_article([{'candidates':[{'features':[0]*16,'label':0}]}], [0])

    def test_regressions_match_ids_not_row_order(self):
        before = [{'id':'a','top3':True},{'id':'b','top3':False}]
        after = [{'id':'b','top3':True},{'id':'a','top3':False}]
        self.assertEqual(m.comparison_by_id(before, after, ['top3']), {'top3':{'newWrong':['a'],'fixed':['b']}})
        for rows in [after[:1], [after[0], after[0]]]:
            with self.assertRaisesRegex(ValueError, 'QUESTION_SET_MISMATCH'):
                m.comparison_by_id(before, rows, ['top3'])

    def test_reference_rejects_changed_dictionary_or_query_mode(self):
        hashes = {name:'hash-'+name for name in ['corpus.js','lookup.js','aliases.js','semantic.js']}
        ref = {'mode':'query만','after':{'indexSha256':'corpus','sourceHashes':hashes},'questionFiles':[{'sha256':'questions'}]}
        ev = {'corpusHash':'corpus','sources':[{'sha256':'questions'}],'codeHashes':{'src/'+k:v for k,v in hashes.items()}}
        m.validate_reference(ref,ev)
        for file in hashes:
            bad = copy.deepcopy(ref);bad['after']['sourceHashes'][file]='changed'
            with self.assertRaisesRegex(ValueError,'SCORER_MISMATCH'):
                m.validate_reference(bad,ev)
        bad=copy.deepcopy(ref);bad['mode']='query+문항 자체 args'
        with self.assertRaisesRegex(ValueError,'QUERY_MODE_MISMATCH'):
            m.validate_reference(bad,ev)


if __name__ == '__main__':
    unittest.main()
