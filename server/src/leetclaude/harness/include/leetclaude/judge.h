// leetclaude result protocol for C/C++/CUDA harnesses (header-only).
//
//   #include <leetclaude/judge.h>
//   lc::test("n = 1024", ok, /*expected*/ "1024 matches", /*actual*/ got, /*message*/ "", /*visible*/ true);
//   lc::metric("kernel_ms", 0.42, "ms");
//
// Events are appended as JSON lines to the file named by $LEETCLAUDE_RESULTS.
#pragma once
#include <cstdio>
#include <cstdlib>
#include <string>

namespace lc {

inline std::string json_escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\t': out += "\\t"; break;
      case '\r': out += "\\r"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

inline void emit_line(const std::string& line) {
  const char* path = std::getenv("LEETCLAUDE_RESULTS");
  FILE* f = std::fopen(path ? path : "results.jsonl", "a");
  if (!f) return;
  std::fputs(line.c_str(), f);
  std::fputc('\n', f);
  std::fclose(f);
}

inline void test(const std::string& name, bool passed, const std::string& expected = "",
                 const std::string& actual = "", const std::string& message = "",
                 bool visible = true) {
  emit_line(std::string("{\"type\":\"test\",\"name\":\"") + json_escape(name) +
            "\",\"status\":\"" + (passed ? "pass" : "fail") + "\",\"visible\":" +
            (visible ? "true" : "false") + ",\"expected\":\"" + json_escape(expected) +
            "\",\"actual\":\"" + json_escape(actual) + "\",\"message\":" +
            (message.empty() ? std::string("null") : "\"" + json_escape(message) + "\"") + "}");
}

inline void error(const std::string& name, const std::string& message, bool visible = true) {
  emit_line(std::string("{\"type\":\"test\",\"name\":\"") + json_escape(name) +
            "\",\"status\":\"error\",\"visible\":" + (visible ? "true" : "false") +
            ",\"message\":\"" + json_escape(message) + "\"}");
}

inline void metric(const std::string& name, double value, const std::string& unit = "") {
  char buf[64];
  std::snprintf(buf, sizeof buf, "%.6g", value);
  emit_line(std::string("{\"type\":\"metric\",\"name\":\"") + json_escape(name) +
            "\",\"value\":" + buf + ",\"unit\":\"" + json_escape(unit) + "\"}");
}

}  // namespace lc
