"""Tests for the named-catalog filter (Messier / Caldwell / Herschel 400)."""

from api.pipeline.catalog import (
    NAMED_CATALOGS,
    filter_to_catalog,
)


def _rows():
    return [
        {"name": "M 31", "common_name": "Andromeda Galaxy"},
        {"name": "M 110", "common_name": None},
        {"name": "NGC 2403", "common_name": None},
        {"name": "NGC 7000", "common_name": "North America Nebula"},
        {"name": "IC 1396", "common_name": None},
        {"name": "M 111", "common_name": None},  # out of Messier range
    ]


def test_herschel400_has_exactly_400_entries():
    assert len(NAMED_CATALOGS["herschel400"]) == 400


def test_messier_catalog_ranges():
    assert NAMED_CATALOGS["messier"] == {str(i) for i in range(1, 111)}
    assert NAMED_CATALOGS["caldwell"] == {str(i) for i in range(1, 110)}


def test_filter_messier_keeps_only_messier_in_range():
    kept = filter_to_catalog(_rows(), "messier")
    names = {r["name"] for r in kept}
    assert names == {"M 31", "M 110"}  # M 111 excluded (>110)


def test_filter_herschel400_matches_ngc_numbers():
    kept = filter_to_catalog(_rows(), "herschel400")
    names = {r["name"] for r in kept}
    # NGC 2403 is in the Herschel 400; NGC 7000 / IC 1396 are not.
    assert "NGC 2403" in names
    assert "NGC 7000" not in names
    assert "IC 1396" not in names


def test_unknown_or_none_filter_is_noop():
    rows = _rows()
    assert filter_to_catalog(rows, None) is rows
    assert filter_to_catalog(rows, "bogus") is rows


def test_designation_parsing_handles_spacing_and_zero_pad():
    rows = [
        {"name": "M31", "common_name": None},      # no space
        {"name": "NGC 0040", "common_name": None},  # zero-padded; NGC 40 is H400
    ]
    assert {r["name"] for r in filter_to_catalog(rows, "messier")} == {"M31"}
    assert {r["name"] for r in filter_to_catalog(rows, "herschel400")} == {"NGC 0040"}
