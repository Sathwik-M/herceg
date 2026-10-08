"""Data preparation in the chart spec: expressions and derived tables.

``hg.col("temp") > 30`` builds a portable expression, and ``hg.derive(df)``
chains transforms (filter, calculate, bin, aggregate, rolling, sort) whose
rows the chart computes in the browser, where they follow streamed updates.
"""

from __future__ import annotations

import datetime as _dt
import numbers
from collections.abc import Callable, Iterable, Iterator, Sequence
from typing import Any

import numpy as np

from ._data import Table

AGGREGATES = (
    *("count", "sum", "mean", "median", "min", "max", "q1", "q3"),
    *("stdev", "variance", "distinct", "first", "last"),
)
ROLLING = ("count", "sum", "mean", "min", "max", "stdev")
# Operations whose result is a value of the field: on a time field, a time.
_KEEPS_KIND = {"mean", "median", "min", "max", "q1", "q3", "first", "last"}


def _literal(value: Any) -> Any:
    """The JSON form of an expression operand."""
    if isinstance(value, Expr):
        return value._json
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, np.datetime64):
        return float(value.astype("datetime64[ms]").astype(np.int64))
    if isinstance(value, _dt.datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
        return moment.timestamp() * 1000
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        number = float(value)
        if not np.isfinite(number):
            raise ValueError(f"expression numbers must be finite, not {value!r}")
        return int(number) if number.is_integer() and abs(number) < 2**53 else number
    raise TypeError(f"cannot use {type(value).__name__} in an expression")


class Expr:
    """A portable expression over a table's columns, built with Python operators.

    Combine conditions with ``&``, ``|``, and ``~`` (``and``/``or``/``not``
    cannot be overloaded), as in pandas.
    """

    __slots__ = ("_json",)

    def __init__(self, json: Any) -> None:
        self._json = json

    def to_json(self) -> Any:
        """The expression as the spec's JSON array."""
        return self._json

    def __repr__(self) -> str:
        return f"Expr({self._json!r})"

    def _op(self, op: str, *others: Any) -> Expr:
        return Expr([op, self._json, *(_literal(other) for other in others)])

    def _rop(self, op: str, other: Any) -> Expr:
        return Expr([op, _literal(other), self._json])

    def __bool__(self) -> bool:
        raise TypeError("an expression is not true or false in Python; combine with & and |")

    __hash__ = None  # type: ignore[assignment]

    def __eq__(self, other: object) -> Expr:  # type: ignore[override]
        return self._op("==", other)

    def __ne__(self, other: object) -> Expr:  # type: ignore[override]
        return self._op("!=", other)

    def __lt__(self, other: Any) -> Expr:
        return self._op("<", other)

    def __le__(self, other: Any) -> Expr:
        return self._op("<=", other)

    def __gt__(self, other: Any) -> Expr:
        return self._op(">", other)

    def __ge__(self, other: Any) -> Expr:
        return self._op(">=", other)

    def __and__(self, other: Any) -> Expr:
        return self._op("and", other)

    def __rand__(self, other: Any) -> Expr:
        return self._rop("and", other)

    def __or__(self, other: Any) -> Expr:
        return self._op("or", other)

    def __ror__(self, other: Any) -> Expr:
        return self._rop("or", other)

    def __invert__(self) -> Expr:
        return Expr(["not", self._json])

    def __add__(self, other: Any) -> Expr:
        return self._op("+", other)

    def __radd__(self, other: Any) -> Expr:
        return self._rop("+", other)

    def __sub__(self, other: Any) -> Expr:
        return self._op("-", other)

    def __rsub__(self, other: Any) -> Expr:
        return self._rop("-", other)

    def __mul__(self, other: Any) -> Expr:
        return self._op("*", other)

    def __rmul__(self, other: Any) -> Expr:
        return self._rop("*", other)

    def __truediv__(self, other: Any) -> Expr:
        return self._op("/", other)

    def __rtruediv__(self, other: Any) -> Expr:
        return self._rop("/", other)

    def __mod__(self, other: Any) -> Expr:
        return self._op("%", other)

    def __pow__(self, other: Any) -> Expr:
        return self._op("pow", other)

    def __neg__(self) -> Expr:
        return Expr(["-", self._json])

    def __abs__(self) -> Expr:
        return Expr(["abs", self._json])

    def sqrt(self) -> Expr:
        return Expr(["sqrt", self._json])

    def exp(self) -> Expr:
        return Expr(["exp", self._json])

    def log(self) -> Expr:
        return Expr(["log", self._json])

    def log10(self) -> Expr:
        return Expr(["log10", self._json])

    def round(self) -> Expr:
        return Expr(["round", self._json])

    def floor(self) -> Expr:
        return Expr(["floor", self._json])

    def ceil(self) -> Expr:
        return Expr(["ceil", self._json])

    def is_in(self, *values: Any) -> Expr:
        """True where the value is one of ``values``."""
        return self._op("in", *values)

    def is_missing(self) -> Expr:
        """True where the value is missing (NaN, or a missing category)."""
        return Expr(["missing", self._json])


def col(name: str) -> Expr:
    """A column of the table an expression is evaluated against."""
    if not isinstance(name, str):
        raise TypeError(f"column names are strings, not {name!r}")
    return Expr(["field", name])


def when(condition: Expr, then: Any, otherwise: Any) -> Expr:
    """``then`` where ``condition`` holds, else ``otherwise``."""
    return Expr(["if", _literal(condition), _literal(then), _literal(otherwise)])


class _Kinds:
    """Column names in order, each kind looked up only when first asked for, so
    columns no step or mark reads are never converted."""

    def __init__(
        self,
        names: Sequence[str],
        known: dict[str, str],
        lookup: Callable[[str], str] | None = None,
    ) -> None:
        self._names = list(dict.fromkeys(names))
        self._set = set(self._names)
        self._known = dict(known)
        self._lookup = lookup

    def __contains__(self, name: object) -> bool:
        return name in self._set

    def __iter__(self) -> Iterator[str]:
        return iter(self._names)

    def __getitem__(self, name: str) -> str:
        if name not in self._known:
            if self._lookup is None or name not in self._set:
                raise KeyError(name)
            self._known[name] = self._lookup(name)
        return self._known[name]

    def adding(self, kinds: dict[str, str]) -> _Kinds:
        """These columns with others added or replaced."""
        return _Kinds([*self._names, *kinds], {**self._known, **kinds}, self.__getitem__)


_COMPARE = {"==", "!=", "<", "<=", ">", ">="}
_ARITHMETIC = {"+", "-", "*", "/", "%", "pow"}
_MATH = {"abs", "sqrt", "exp", "log", "log10", "round", "floor", "ceil"}


def _type(json: Any, kinds: _Kinds) -> str:
    """What an expression evaluates to ("number", "string", "boolean", or
    "missing" for null), checked as the chart's compiler checks it."""
    if json is None:
        return "missing"
    if isinstance(json, bool):
        return "boolean"
    if isinstance(json, (int, float)):
        return "number"
    if isinstance(json, str):
        return "string"
    op, *args = json

    def typed(arg: Any, expected: str) -> None:
        found = _type(arg, kinds)
        if found != expected and not (found == "missing" and expected == "number"):
            raise TypeError(f"{op!r} needs {expected} operands, not {found}")

    def arity(count: int) -> None:
        if len(args) != count:
            raise TypeError(f"{op!r} takes {count} operand{'s' * (count != 1)}, not {len(args)}")

    if op == "field":
        name = args[0]
        if name not in kinds:
            raise KeyError(f"no column {name!r}; the rows have {', '.join(map(repr, kinds))}")
        return "string" if kinds[name] == "category" else "number"
    if op in _COMPARE:
        arity(2)
        a, b = (_type(arg, kinds) for arg in args)
        if "missing" in (a, b):
            if op not in ("==", "!="):
                raise TypeError(f"{op!r} cannot compare with None")
        elif a != b:
            raise TypeError(f"{op!r} compares {a} with {b}; both sides need one type")
        return "boolean"
    if op in ("and", "or", "not"):
        if op == "not":
            arity(1)
        for arg in args:
            typed(arg, "boolean")
        return "boolean"
    if op in _ARITHMETIC or op in _MATH or op in ("min", "max"):
        if op in _ARITHMETIC and not (op == "-" and len(args) == 1):
            arity(2)
        if op in _MATH:
            arity(1)
        for arg in args:
            typed(arg, "number")
        return "number"
    if op == "in":
        if len(args) < 2:
            raise TypeError("'in' needs a value and at least one candidate")
        value = _type(args[0], kinds)
        for candidate in args[1:]:
            if isinstance(candidate, list) or (
                candidate is not None and _type(candidate, kinds) != value
            ):
                raise TypeError(f"'in' candidates must be {value} literals")
        return "boolean"
    if op == "missing":
        arity(1)
        _type(args[0], kinds)
        return "boolean"
    if op == "if":
        arity(3)
        typed(args[0], "boolean")
        then, otherwise = (_type(arg, kinds) for arg in args[1:])
        if "missing" not in (then, otherwise) and then != otherwise:
            raise TypeError(f"'if' branches give {then} and {otherwise}; they need one type")
        kind = then if then != "missing" else otherwise
        return "number" if kind == "missing" else kind
    raise TypeError(f"unknown expression operator {op!r}")


def _fields_of(json: Any) -> set[str]:
    """The columns an expression reads."""
    if isinstance(json, list):
        if json and json[0] == "field":
            return {json[1]}
        return set().union(*(_fields_of(item) for item in json[1:]))
    return set()


def _value_kind(json: Any, kinds: _Kinds) -> str:
    """The kind of column an expression's values make: text makes categories, and
    anything else numbers, as in the chart (a copy of a time column too)."""
    return "category" if _type(json, kinds) == "string" else "number"


def _real(value: Any) -> bool:
    """Whether a value is a finite number, and not True or False."""
    return (
        isinstance(value, numbers.Real) and not isinstance(value, bool) and bool(np.isfinite(value))
    )


class Derived:
    """Rows computed from a data source by transforms, in the chart's browser.

    Build one with ``hg.derive(data)`` and pass it as a chart's or mark's
    data. Every step checks the columns it reads against those before it.
    """

    def __init__(
        self,
        source: Any,
        steps: Sequence[dict[str, Any]],
        kinds: _Kinds,
        table: Table | None = None,
    ) -> None:
        self.source = source
        self.steps: tuple[dict[str, Any], ...] = tuple(steps)
        self._kinds = kinds
        # The source's converted columns, shared with charts of this table.
        self._table = table

    @property
    def columns(self) -> dict[str, str]:
        """The derived table's columns and their kinds."""
        return {name: self._kinds[name] for name in self._kinds}

    def _then(self, step: dict[str, Any], kinds: _Kinds) -> Derived:
        return Derived(self.source, [*self.steps, step], kinds, self._table)

    def _require(self, names: Any, role: str, kinds: tuple[str, ...] | None = None) -> None:
        for name in [names] if isinstance(names, str) else names:
            if name not in self._kinds:
                available = ", ".join(repr(known) for known in self._kinds)
                raise KeyError(f"{role}: no column {name!r}; the rows have {available}")
            if kinds is not None and self._kinds[name] not in kinds:
                raise TypeError(
                    f"{role}: column {name!r} holds {self._kinds[name]} values; "
                    f"expected {' or '.join(kinds)}"
                )

    def filter(self, condition: Expr) -> Derived:
        """Keeps rows where ``condition`` is true."""
        json = _literal(condition)
        self._require(sorted(_fields_of(json)), "filter")
        kind = _checked(json, self._kinds, "filter")
        if kind != "boolean":
            raise TypeError(f"filter needs a true or false condition, not a {kind} expression")
        return self._then({"filter": json}, self._kinds)

    def calculate(self, name: str, value: Any) -> Derived:
        """Adds (or replaces) the column ``name`` with the value of an expression."""
        json = _literal(value)
        self._require(sorted(_fields_of(json)), "calculate")
        _checked(json, self._kinds, "calculate")
        kind = _value_kind(json, self._kinds)
        return self._then({"calculate": json, "as": name}, self._kinds.adding({name: kind}))

    def bin(
        self,
        column: str,
        *,
        step: float | None = None,
        count: int | None = None,
        start: float | None = None,
        name: str | None = None,
    ) -> Derived:
        """Replaces a number or time column (or adds ``name``) with the start of its bin:
        ``step`` wide from ``start``, or about ``count`` round bins (default 10)."""
        self._require(column, "bin", ("number", "time"))
        if step is not None and not (_real(step) and step > 0):
            raise ValueError(f"bin step must be a positive number, not {step!r}")
        if count is not None and not (
            isinstance(count, int) and not isinstance(count, bool) and count >= 1
        ):
            raise ValueError(f"bin count must be a whole number of at least 1, not {count!r}")
        if start is not None and not _real(start):
            raise ValueError(f"bin start must be a finite number, not {start!r}")
        # NumPy numbers as JSON numbers.
        step, start = _literal(step), _literal(start)
        spec = {"bin": column, "as": name, "step": step, "count": count, "start": start}
        kinds = self._kinds.adding({name or column: self._kinds[column]})
        return self._then({k: v for k, v in spec.items() if v is not None}, kinds)

    def aggregate(self, by: str | Sequence[str] | None = None, **operations: Any) -> Derived:
        """One row per group of ``by`` columns, with each named operation, as in
        pandas' named aggregation: ``n="count"`` or ``mean=("temp", "mean")``."""
        groupby = [by] if isinstance(by, str) else list(by or [])
        self._require(groupby, "aggregate by")
        if not operations:
            raise ValueError("aggregate needs at least one operation, such as n='count'")
        specs = []
        kinds = {name: self._kinds[name] for name in groupby}
        for name, operation in operations.items():
            column, op = (None, operation) if isinstance(operation, str) else tuple(operation)
            if op not in AGGREGATES:
                raise ValueError(
                    f"aggregate {name}: unknown operation {op!r}; use one of {AGGREGATES}"
                )
            if column is None and op != "count":
                raise ValueError(f"aggregate {name}: {op!r} needs a column, as ('column', {op!r})")
            if column is not None:
                self._require(column, f"aggregate {name}", ("number", "time"))
            specs.append({"op": op, **({"field": column} if column else {}), "as": name})
            keeps = column is not None and op in _KEEPS_KIND and self._kinds[column] == "time"
            kinds[name] = "time" if keeps else "number"
        step = {"aggregate": specs, **({"groupby": groupby} if groupby else {})}
        return self._then(step, _Kinds(list(kinds), kinds))

    def rolling(
        self, size: int, *, by: str | Sequence[str] | None = None, **operations: Any
    ) -> Derived:
        """Adds each named operation over the trailing ``size`` rows, within each
        group of ``by`` columns: ``avg=("temp", "mean")``."""
        if not (isinstance(size, int) and not isinstance(size, bool) and size >= 1):
            raise ValueError(f"rolling size must be a whole number of at least 1, not {size!r}")
        groupby = [by] if isinstance(by, str) else list(by or [])
        self._require(groupby, "rolling by")
        if not operations:
            raise ValueError("rolling needs at least one operation, such as avg=('temp', 'mean')")
        specs = []
        kinds: dict[str, str] = {}
        for name, operation in operations.items():
            column, op = tuple(operation)
            if op not in ROLLING:
                raise ValueError(f"rolling {name}: unknown operation {op!r}; use one of {ROLLING}")
            self._require(column, f"rolling {name}", ("number", "time"))
            specs.append({"op": op, "field": column, "as": name})
            keeps = op in _KEEPS_KIND and self._kinds[column] == "time"
            kinds[name] = "time" if keeps else "number"
        step = {"rolling": specs, "size": size, **({"groupby": groupby} if groupby else {})}
        return self._then(step, self._kinds.adding(kinds))

    def sort(self, column: str, *, descending: bool = False) -> Derived:
        """Orders rows by a column, stably, missing values last."""
        self._require(column, "sort")
        return self._then(
            {"sort": column, "order": "descending" if descending else "ascending"}, self._kinds
        )

    def source_columns(self, used: Iterable[str] = ()) -> set[str]:
        """Columns of the source the steps read, and those of ``used`` (columns read
        from the derived rows) that come from the source unchanged. A column read
        after a step made or replaced it is not the source's."""
        needs: set[str] = set()
        made: set[str] = set()
        for step in self.steps:
            needs |= _reads(step) - made
            made |= _writes(step)
        return needs | ({name for name in used if name in self._kinds} - made)


def _reads(step: dict[str, Any]) -> set[str]:
    """The columns a step reads."""
    reads: set[str] = set()
    for key in ("filter", "calculate"):
        if key in step:
            reads |= _fields_of(step[key])
    for key in ("bin", "sort"):
        if key in step:
            reads.add(step[key])
    reads |= set(step.get("groupby", []))
    for operation in step.get("aggregate", []) + step.get("rolling", []):
        if "field" in operation:
            reads.add(operation["field"])
    return reads


def _writes(step: dict[str, Any]) -> set[str]:
    """The columns a step makes or replaces: an aggregate makes every column of its rows."""
    if "calculate" in step:
        return {step["as"]}
    if "bin" in step:
        return {step.get("as", step["bin"])}
    if "aggregate" in step:
        return {*step.get("groupby", []), *(operation["as"] for operation in step["aggregate"])}
    return {operation["as"] for operation in step.get("rolling", [])}


def _checked(json: Any, kinds: _Kinds, role: str) -> str:
    """An expression's type, with errors naming the step."""
    try:
        return _type(json, kinds)
    except (KeyError, TypeError) as error:
        message = error.args[0] if error.args else str(error)
        raise type(error)(f"{role}: {message}") from None


def derive(data: Any) -> Derived:
    """Starts transforms of a data source (or of another derived table)."""
    if isinstance(data, Derived):
        return Derived(data, [], data._kinds)
    table = Table(data)
    return Derived(data, [], _Kinds(table.names, {}, lambda name: table.column(name).kind), table)
