"""Builds the 'shop' fixture: a small multi-module Python project with seeded work for the worker benchmark."""
import os, subprocess, textwrap

FILES = {
"shop/__init__.py": "",
"shop/models.py": '''
from dataclasses import dataclass, field


@dataclass
class Item:
    sku: str
    name: str
    unit_price_cents: int
    qty: int = 0
    promo: bool = False
    tags: list = field(default_factory=list)

    def line_total_cents(self):
        return self.unit_price_cents * self.qty
''',
"shop/store.py": '''
from .models import Item
from .pricing import apply_tax


class Store:
    def __init__(self):
        self._items = {}

    def add(self, item: Item):
        if item.sku in self._items:
            raise ValueError(f"duplicate sku {item.sku}")
        self._items[item.sku] = item

    def get_item(self, sku):
        return self._items.get(sku)

    def remove(self, sku):
        return self._items.pop(sku, None)

    def items(self):
        return sorted(self._items.values(), key=lambda i: i.sku)

    def subtotal_cents(self):
        return sum(i.line_total_cents() for i in self.items())

    def total_cents(self, tax_rate=0.0):
        return apply_tax(self.subtotal_cents(), tax_rate)
''',
"shop/pricing.py": '''
def apply_tax(cents, rate):
    """Add tax, rounded to the nearest cent."""
    return int(cents * (1 + rate))


def percent_off(cents, percent):
    return cents - cents * percent // 100
''',
"shop/report.py": '''
from .store import Store


def format_money(cents):
    return f"${cents // 100}.{cents % 100:02d}"


def page(items, page_no, per_page=3):
    """1-based pagination."""
    start = page_no * per_page
    return items[start:start + per_page]


def render(store: Store, page_no=1, tax_rate=0.0):
    lines = []
    for item in page(store.items(), page_no):
        lines.append(f"{item.sku:<8}{item.name:<16}{item.qty:>3} x {format_money(item.unit_price_cents)}")
    lines.append(f"TOTAL {format_money(store.total_cents(tax_rate))}")
    return "\\n".join(lines)
''',
"shop/cli.py": '''
import sys
from .models import Item
from .store import Store
from .report import render


def main(argv=None):
    store = Store()
    store.add(Item("A1", "widget", 250, 4))
    store.add(Item("B2", "gadget", 1999, 1))
    store.add(Item("C3", "gizmo", 75, 10, promo=True))
    item = store.get_item("A1")
    print(f"first: {item.name}")
    print(render(store, 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
''',
"tests/__init__.py": "",
"tests/test_store.py": '''
import unittest
from shop.models import Item
from shop.store import Store


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.s = Store()
        self.s.add(Item("A1", "widget", 250, 4))
        self.s.add(Item("B2", "gadget", 1999, 1))

    def test_get_item(self):
        self.assertEqual(self.s.get_item("A1").name, "widget")
        self.assertIsNone(self.s.get_item("ZZ"))

    def test_duplicate(self):
        with self.assertRaises(ValueError):
            self.s.add(Item("A1", "again", 1, 1))

    def test_subtotal(self):
        self.assertEqual(self.s.subtotal_cents(), 250 * 4 + 1999)

    def test_total_with_tax(self):
        self.assertEqual(self.s.total_cents(0.1), 3299)  # 2999 * 1.1 = 3298.9 -> 3299
''',
"tests/test_report.py": '''
import unittest
from shop.models import Item
from shop.store import Store
from shop.report import page, render


class ReportTests(unittest.TestCase):
    def test_page_one_is_first_items(self):
        self.assertEqual(page([1, 2, 3, 4, 5], 1), [1, 2, 3])

    def test_page_two(self):
        self.assertEqual(page([1, 2, 3, 4, 5], 2), [4, 5])

    def test_render_first_page(self):
        s = Store()
        for n, sku in enumerate(["A", "B", "C", "D"]):
            s.add(Item(sku, "n" + sku, 100, n + 1))
        out = render(s, 1)
        self.assertIn("A", out.splitlines()[0])
        self.assertTrue(out.splitlines()[-1].startswith("TOTAL"))
''',
"tests/test_pricing.py": '''
import unittest
from shop.pricing import apply_tax, percent_off


class PricingTests(unittest.TestCase):
    def test_percent_off(self):
        self.assertEqual(percent_off(1000, 10), 900)

    def test_tax_rounds(self):
        self.assertEqual(apply_tax(2999, 0.1), 3299)
''',
"README.md": "# shop\n\nTiny inventory/pricing library used as a worker benchmark fixture.\nRun tests: python -m unittest discover -s tests -t .\n",
}

FIXES = {
    "shop/pricing.py": ("return int(cents * (1 + rate))", "return round(cents * (1 + rate))"),
    "shop/report.py": ("start = page_no * per_page", "start = (page_no - 1) * per_page"),
}


def build(dest, fixed=False):
    for rel, body in FILES.items():
        p = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").write(textwrap.dedent(body).lstrip("\n") if rel.endswith(".py") else body)
    if fixed:
        for rel, (a, b) in FIXES.items():
            p = os.path.join(dest, rel)
            t = open(p).read()
            assert a in t, rel
            open(p, "w").write(t.replace(a, b))
    run = lambda *a: subprocess.run(a, cwd=dest, check=True, capture_output=True)
    run("git", "init", "-q"); run("git", "add", "-A")
    run("git", "-c", "user.name=b", "-c", "user.email=b@b", "commit", "-qm", "fixture")

if __name__ == "__main__":
    import sys; build(sys.argv[1], fixed="--fixed" in sys.argv)
