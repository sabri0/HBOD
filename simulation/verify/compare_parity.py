"""Compare decrease decisions of the Python rule-based prototype (py_v1.npy) with the JavaScript code (js_dec.json)."""
import json
import numpy as np
py = np.load('py_v1.npy')            # floor of the prototype score: number of active flags, -1 when no entry
js = json.load(open('js_dec.json'))  # [athlete, day, 1 if DECREASE else 0] for every athlete-day with an entry
same = sum(int((py[i, t] >= 1) == bool(d)) for i, t, d in js)
print(f'{same} of {len(js)} athlete-days with an entry give the same decision')
