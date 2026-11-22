#include "kernel.h"

__global__ void vector_add(const float* a, const float* b, float* c, int n) {
    // TODO: compute this thread's global index and add one element
}

void launch_vector_add(const float* d_a, const float* d_b, float* d_c, int n) {
    // TODO: launch vector_add with 256 threads per block
}
