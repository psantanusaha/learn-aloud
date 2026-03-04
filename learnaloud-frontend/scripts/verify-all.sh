#!/bin/bash

# LearnAloud Full Verification Runner
# Runs all tests and generates a summary report

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Configuration
FRONTEND_URL="http://localhost:4200"
BACKEND_URL="http://localhost:8000"

# Results tracking
CORE_LOOP_PASSED=0
CORE_LOOP_TOTAL=0
CORE_LOOP_STATUS="pending"

VISUAL_PASSED=0
VISUAL_TOTAL=0
VISUAL_STATUS="pending"

NETWORK_STATUS="pending"

OVERALL_STATUS="PASS"

# Print header
print_header() {
    echo ""
    echo -e "${BLUE}═════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}  LearnAloud Full Verification Suite${NC}"
    echo -e "${BLUE}═════════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Print section header
print_section() {
    echo ""
    echo -e "${YELLOW}─────────────────────────────────────${NC}"
    echo -e "${BOLD}  $1${NC}"
    echo -e "${YELLOW}─────────────────────────────────────${NC}"
    echo ""
}

# Check if a server is running
check_server() {
    local url=$1
    local name=$2

    echo -n "Checking $name at $url... "

    if curl -s --head --connect-timeout 5 "$url" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Running${NC}"
        return 0
    else
        echo -e "${RED}✗ Not running${NC}"
        return 1
    fi
}

# Parse Playwright test output for pass/fail counts
parse_playwright_results() {
    local output=$1

    # Extract passed/failed counts from Playwright output
    # Format: "X passed" or "X failed"
    local passed=$(echo "$output" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || echo "0")
    local failed=$(echo "$output" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || echo "0")

    echo "$passed $failed"
}

# Run core loop E2E tests
run_core_loop_tests() {
    print_section "Core Loop E2E Tests"

    local output
    local exit_code=0

    echo "Running: npm run test:e2e"
    echo ""

    # Run tests and capture output
    output=$(npm run test:e2e 2>&1) || exit_code=$?

    # Parse results
    local results=$(parse_playwright_results "$output")
    CORE_LOOP_PASSED=$(echo "$results" | cut -d' ' -f1)
    local failed=$(echo "$results" | cut -d' ' -f2)
    CORE_LOOP_TOTAL=$((CORE_LOOP_PASSED + failed))

    # If we couldn't parse, try to get from the test list
    if [ "$CORE_LOOP_TOTAL" -eq 0 ]; then
        CORE_LOOP_TOTAL=8  # Known number of tests
        if [ $exit_code -eq 0 ]; then
            CORE_LOOP_PASSED=8
        fi
    fi

    if [ $exit_code -eq 0 ]; then
        CORE_LOOP_STATUS="passed"
        echo -e "${GREEN}✓ All core loop tests passed${NC}"
    else
        CORE_LOOP_STATUS="failed"
        OVERALL_STATUS="FAIL"
        echo -e "${RED}✗ Some core loop tests failed${NC}"
        echo ""
        echo "Output:"
        echo "$output" | tail -30
    fi

    return $exit_code
}

# Run visual regression tests
run_visual_tests() {
    print_section "Visual Regression Tests"

    local output
    local exit_code=0

    echo "Running: npm run test:visual"
    echo ""

    # Run tests and capture output
    output=$(npm run test:visual 2>&1) || exit_code=$?

    # Parse results
    local results=$(parse_playwright_results "$output")
    VISUAL_PASSED=$(echo "$results" | cut -d' ' -f1)
    local failed=$(echo "$results" | cut -d' ' -f2)
    VISUAL_TOTAL=$((VISUAL_PASSED + failed))

    # If we couldn't parse, try to get from the test list
    if [ "$VISUAL_TOTAL" -eq 0 ]; then
        VISUAL_TOTAL=9  # Known number of tests (including sub-tests)
        if [ $exit_code -eq 0 ]; then
            VISUAL_PASSED=9
        fi
    fi

    if [ $exit_code -eq 0 ]; then
        VISUAL_STATUS="passed"
        echo -e "${GREEN}✓ All visual regression tests passed${NC}"
    else
        VISUAL_STATUS="failed"
        OVERALL_STATUS="FAIL"
        echo -e "${RED}✗ Some visual regression tests failed${NC}"
        echo ""
        echo "Output:"
        echo "$output" | tail -30
    fi

    return $exit_code
}

# Run network audit
run_network_audit() {
    print_section "Network Audit"

    local output
    local exit_code=0

    echo "Running: npm run audit:network"
    echo ""

    # Run audit and capture output
    output=$(npm run audit:network 2>&1) || exit_code=$?

    if [ $exit_code -eq 0 ]; then
        NETWORK_STATUS="clean"
        echo -e "${GREEN}✓ Landing page is clean (no unwanted API calls)${NC}"
    else
        NETWORK_STATUS="dirty"
        OVERALL_STATUS="FAIL"
        echo -e "${RED}✗ Network audit found issues${NC}"
        echo ""
        echo "Output:"
        echo "$output" | tail -30
    fi

    return $exit_code
}

# Print final summary
print_summary() {
    echo ""
    echo -e "${BLUE}═════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}  LearnAloud Verification Report${NC}"
    echo -e "${BLUE}═════════════════════════════════════════════════════════════${NC}"
    echo ""

    # Core loop tests
    if [ "$CORE_LOOP_STATUS" = "passed" ]; then
        echo -e "  Core loop tests:    ${GREEN}${CORE_LOOP_PASSED}/${CORE_LOOP_TOTAL} passed ✓${NC}"
    elif [ "$CORE_LOOP_STATUS" = "failed" ]; then
        local failed=$((CORE_LOOP_TOTAL - CORE_LOOP_PASSED))
        echo -e "  Core loop tests:    ${RED}${CORE_LOOP_PASSED}/${CORE_LOOP_TOTAL} passed, ${failed} failed ✗${NC}"
    else
        echo -e "  Core loop tests:    ${YELLOW}skipped${NC}"
    fi

    # Visual regression
    if [ "$VISUAL_STATUS" = "passed" ]; then
        echo -e "  Visual regression:  ${GREEN}${VISUAL_PASSED}/${VISUAL_TOTAL} passed ✓${NC}"
    elif [ "$VISUAL_STATUS" = "failed" ]; then
        local failed=$((VISUAL_TOTAL - VISUAL_PASSED))
        echo -e "  Visual regression:  ${RED}${VISUAL_PASSED}/${VISUAL_TOTAL} passed, ${failed} failed ✗${NC}"
    else
        echo -e "  Visual regression:  ${YELLOW}skipped${NC}"
    fi

    # Network audit
    if [ "$NETWORK_STATUS" = "clean" ]; then
        echo -e "  Network audit:      ${GREEN}landing page clean ✓${NC}"
    elif [ "$NETWORK_STATUS" = "dirty" ]; then
        echo -e "  Network audit:      ${RED}issues found ✗${NC}"
    else
        echo -e "  Network audit:      ${YELLOW}skipped${NC}"
    fi

    echo ""
    echo -e "${BLUE}─────────────────────────────────────────────────────────────${NC}"

    if [ "$OVERALL_STATUS" = "PASS" ]; then
        echo -e "  Overall: ${GREEN}${BOLD}PASS${NC}"
    else
        echo -e "  Overall: ${RED}${BOLD}FAIL${NC}"
    fi

    echo -e "${BLUE}═════════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Main execution
main() {
    print_header

    # Check prerequisites
    print_section "Checking Prerequisites"

    local frontend_ok=true
    local backend_ok=true

    check_server "$FRONTEND_URL" "Frontend" || frontend_ok=false
    check_server "$BACKEND_URL" "Backend" || backend_ok=false

    if [ "$frontend_ok" = false ]; then
        echo ""
        echo -e "${RED}ERROR: Frontend server is not running!${NC}"
        echo "Please start the Angular dev server:"
        echo "  npm start"
        echo ""
        exit 1
    fi

    if [ "$backend_ok" = false ]; then
        echo ""
        echo -e "${YELLOW}WARNING: Backend server is not running!${NC}"
        echo "Some tests may fail. Start the backend with:"
        echo "  cd ../backend && python app.py"
        echo ""
        echo "Continuing anyway..."
    fi

    # Track failures for final exit code
    local has_failures=false

    # Run all test suites
    # Continue even if one fails (set +e temporarily)
    set +e

    run_core_loop_tests || has_failures=true
    run_visual_tests || has_failures=true
    run_network_audit || has_failures=true

    set -e

    # Print summary
    print_summary

    # Exit with appropriate code
    if [ "$OVERALL_STATUS" = "PASS" ]; then
        exit 0
    else
        exit 1
    fi
}

# Run main
main "$@"
